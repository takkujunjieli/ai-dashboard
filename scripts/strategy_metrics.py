#!/usr/bin/env python3
"""回测结果的风险/收益指标(纯 Python,PR4 框架核心)。

输入 `run_backtest` 的返回 dict,产出:Sharpe / Sortino / profit factor / payoff /
期望值(expectancy)/ 平均盈亏 / 暴露度(exposure)/ CAGR。所有指标基于**净收益**
(已扣成本的 `return_pct`)。年化因子未知时报"每 bar"口径,给了 `ann_factor` 才年化。
"""
from __future__ import annotations

import math
import statistics
from datetime import datetime


def _bar_returns(curve):
    """从权益曲线取每 bar 简单收益 r_t = eq_t/eq_{t-1} − 1。"""
    eq = [p["equity"] for p in curve if p.get("equity")]
    return [(eq[i] / eq[i - 1] - 1.0) for i in range(1, len(eq)) if eq[i - 1]]


def _years_span(curve):
    """曲线首末时间跨度(年);t 不是可解析的 ISO 时间则返回 None。"""
    ts = [p.get("t") for p in curve if p.get("t") is not None]
    if len(ts) < 2 or not isinstance(ts[0], str):
        return None
    try:
        a, b = datetime.fromisoformat(str(ts[0])), datetime.fromisoformat(str(ts[-1]))
    except ValueError:
        return None
    yrs = (b - a).total_seconds() / (365.25 * 86400)
    return yrs if yrs > 0 else None


def compute_metrics(result: dict, ann_factor: float | None = None) -> dict:
    """result: run_backtest 的返回。ann_factor: 年化因子(如日线≈252),None=不年化。"""
    curve = result.get("equity_curve") or []
    trades = result.get("trades") or []
    rets = _bar_returns(curve)
    rprofit = [t["return_pct"] for t in trades]              # 每笔净收益 %
    wins = [x for x in rprofit if x > 0]
    losses = [x for x in rprofit if x < 0]

    out: dict = {}
    # Sharpe / Sortino(基于每 bar 收益)
    if len(rets) >= 2:
        mu = statistics.fmean(rets)
        sd = statistics.stdev(rets)
        dn = [r for r in rets if r < 0]
        dsd = statistics.stdev(dn) if len(dn) >= 2 else 0.0
        scale = math.sqrt(ann_factor) if ann_factor else 1.0
        out["sharpe"] = round(mu / sd * scale, 3) if sd else None
        out["sortino"] = round(mu / dsd * scale, 3) if dsd else None
    else:
        out["sharpe"] = out["sortino"] = None

    # 交易层面
    out["profit_factor"] = round(sum(wins) / abs(sum(losses)), 3) if losses else (None if not wins else float("inf"))
    out["avg_win_pct"] = round(statistics.fmean(wins), 3) if wins else 0.0
    out["avg_loss_pct"] = round(statistics.fmean(losses), 3) if losses else 0.0
    out["payoff"] = round(out["avg_win_pct"] / abs(out["avg_loss_pct"]), 3) if losses and out["avg_loss_pct"] else None
    wr = (len(wins) / len(trades)) if trades else 0.0
    out["expectancy_pct"] = round(wr * out["avg_win_pct"] + (1 - wr) * out["avg_loss_pct"], 4) if trades else 0.0

    # 暴露度:持仓 bar 占比
    if curve:
        out["exposure"] = round(sum(1 for p in curve if p.get("position", "FLAT") != "FLAT") / len(curve), 3)
    else:
        out["exposure"] = 0.0

    # CAGR(需要真实时间跨度)
    yrs = _years_span(curve)
    tr = result.get("total_return_pct", 0.0) / 100.0
    out["cagr_pct"] = round(((1 + tr) ** (1 / yrs) - 1) * 100.0, 2) if (yrs and 1 + tr > 0) else None
    return out


def _selftest():
    ap = lambda a, b: abs(a - b) < 1e-6  # noqa: E731
    # 造一个确定性 result:两笔 +2% / −1%(净),权益曲线单调
    result = {
        "total_return_pct": 0.98,
        "trades": [{"return_pct": 2.0}, {"return_pct": -1.0}],
        "equity_curve": [{"t": "2026-01-01T00:00:00", "equity": 10000, "position": "LONG"},
                         {"t": "2026-07-01T00:00:00", "equity": 10200, "position": "FLAT"},
                         {"t": "2027-01-01T00:00:00", "equity": 10098, "position": "SHORT"}],
    }
    m = compute_metrics(result, ann_factor=None)
    assert ap(m["profit_factor"], 2.0)              # 2.0 / 1.0
    assert ap(m["avg_win_pct"], 2.0) and ap(m["avg_loss_pct"], -1.0) and ap(m["payoff"], 2.0)
    assert ap(m["expectancy_pct"], 0.5)             # 0.5*2 + 0.5*(-1)
    assert abs(m["exposure"] - round(2 / 3, 3)) < 1e-9   # 2 段持仓 / 3 点
    assert m["cagr_pct"] is not None                # 有 1 年跨度
    # 无交易 → 安全
    empty = compute_metrics({"total_return_pct": 0.0, "trades": [], "equity_curve": []})
    assert empty["sharpe"] is None and empty["exposure"] == 0.0
    print("strategy_metrics selftest: ALL PASS")


if __name__ == "__main__":
    _selftest()
