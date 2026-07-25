#!/usr/bin/env python3
"""Walk-forward / 样本外(OOS)验证 + 网格寻优(纯 Python,PR6 框架核心)。

**红线**:网格寻优是过拟合机器——在同一份数据上挑参又评估,小样本必出虚假最优。
本模块强制:**参数只在训练窗选(in-sample),表现只在紧接的测试窗算(out-of-sample)**,
滚动前移、把各测试窗的 OOS 结果串起来 → 这才是站得住的策略表现。

- `grid_search(prices, signals, ..., grid)`:遍历参数网格,按 score 选最优(**样本内**打分)。
- `walk_forward(prices, signals, ..., grid, train, test, step)`:每折在 train 窗寻优 → 应用到
  test 窗(OOS)→ 串联所有测试窗得 OOS 权益曲线 + 汇总统计 + 每折选中的参数(看稳定性)。

score 默认 = 总收益 /(最大回撤+1)(对空样本/None 稳健);可换成 Sharpe 等。
"""
from __future__ import annotations

import itertools

from strategy_backtest import run_backtest


def _iter_grid(grid: dict):
    """{param:[v...]} → 逐个参数组合 dict。"""
    keys = list(grid)
    for combo in itertools.product(*(grid[k] for k in keys)):
        yield dict(zip(keys, combo))


def _score_default(res: dict) -> float:
    """总收益 /(最大回撤+1):回撤惩罚、对 0 交易/极端回撤稳健。"""
    return res.get("total_return_pct", 0.0) / (res.get("max_drawdown_pct", 0.0) + 1.0)


def grid_search(prices, signals, times=None, *, grid: dict, score=_score_default, **base) -> dict | None:
    """在一段数据上遍历参数网格,返回 score 最高的 {score, params, result}(**样本内**,只该在 train 窗用)。"""
    best = None
    for combo in _iter_grid(grid):
        res = run_backtest(prices, signals, times, **{**base, **combo})
        s = score(res)
        if best is None or s > best["score"]:
            best = {"score": s, "params": combo, "result": res}
    return best


def walk_forward(prices, signals, times=None, *, grid: dict, train: int, test: int,
                 step: int | None = None, score=_score_default, initial_equity: float = 10000.0, **base) -> dict:
    """滚动 walk-forward:每折 train 窗寻优 → test 窗(OOS)应用 → 串联。

    train/test/step = 训练窗/测试窗/前移步长(bar 数);step 缺省=test(测试窗不重叠)。
    返回 {n_folds, folds[], oos_total_return_pct, oos_win_rate, oos_max_drawdown_pct, oos_equity_curve}。
    """
    n = len(prices)
    step = step or test
    folds, oos_curve, oos_trades = [], [], []
    run_eq, peak, max_dd = float(initial_equity), float(initial_equity), 0.0
    i = 0
    while i + train + test <= n:
        tr, te = slice(i, i + train), slice(i + train, i + train + test)
        gs = grid_search(prices[tr], signals[tr], (times[tr] if times else None), grid=grid, score=score, **base)
        params = gs["params"] if gs else {}
        r = run_backtest(prices[te], signals[te], (times[te] if times else None), **{**base, **params})

        # 串联 OOS 权益曲线:把本折 test 曲线(内部基准 initial_equity)缩放到当前累计权益
        for p in r["equity_curve"]:
            eq = round(run_eq * p["equity"] / initial_equity, 2)
            peak = max(peak, eq)
            max_dd = max(max_dd, (peak - eq) / peak * 100.0)
            oos_curve.append({"t": p["t"], "equity": eq, "position": p["position"]})
        # 用本折已平仓交易推进累计权益
        for t in r["trades"]:
            run_eq *= (1 + t["return_pct"] / 100.0)
            oos_trades.append(t)

        folds.append({"train": [i, i + train], "test": [i + train, i + train + test],
                      "params": params, "oos_return_pct": r["total_return_pct"], "oos_trades": r["total_trades"]})
        i += step

    wins = sum(1 for t in oos_trades if t["return_pct"] > 0)
    return {"method": "walk_forward", "train": train, "test": test, "step": step, "n_folds": len(folds),
            "oos_total_return_pct": round((run_eq - initial_equity) / initial_equity * 100.0, 2),
            "oos_trades": len(oos_trades),
            "oos_win_rate": round(wins / len(oos_trades) * 100.0, 2) if oos_trades else 0.0,
            "oos_max_drawdown_pct": round(max_dd, 2),
            "folds": folds, "oos_equity_curve": oos_curve}


def _selftest():
    # 造带噪上升序列 + 隔根信号
    prices = [100 + i * 0.5 + (i % 3) for i in range(60)]
    signals = [1 if i % 2 == 0 else 0 for i in range(60)]
    grid = {"take_profit_pct": [1, 2, 3], "stop_loss_pct": [1, 2], "max_holding_bars": [5, 10]}

    # grid_search 必须挑到网格内 score 最高的组合(与暴力枚举一致)
    gs = grid_search(prices, signals, grid=grid, cost_bps=0, entry_lag=1)
    brute = max(_score_default(run_backtest(prices, signals, cost_bps=0, entry_lag=1, **c)) for c in _iter_grid(grid))
    assert abs(gs["score"] - brute) < 1e-9 and gs["params"] in list(_iter_grid(grid))

    # walk_forward:n=60, train20/test10/step10 → i=0,10,20,30 → 4 折
    wf = walk_forward(prices, signals, grid=grid, train=20, test=10, step=10, cost_bps=0)
    assert wf["n_folds"] == 4 and len(wf["folds"]) == 4
    assert all(f["params"] for f in wf["folds"]) and 0 <= wf["oos_win_rate"] <= 100
    assert len(wf["oos_equity_curve"]) == 40   # 4 折 × 10 test bars

    # 数据不够 → 0 折,不报错
    assert walk_forward(prices[:15], signals[:15], grid=grid, train=20, test=10)["n_folds"] == 0
    print("strategy_walkforward selftest: ALL PASS")


if __name__ == "__main__":
    _selftest()
