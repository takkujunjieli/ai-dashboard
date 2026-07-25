#!/usr/bin/env python3
"""基准 + 空对照 + 通用信号构造器(纯 Python,PR4 框架核心)。

- baselines:`buy_and_hold`(多头持有基准)、`random_signals`(随机 null,判"有没有真 edge")。
- signal builders:把任意"值序列/价格"转成逐 bar 信号 {-1,0,+1},喂给 strategy_backtest。
  信号无关框架的关键:任何指标只要能对齐到每根 bar,就能插进来跑。
"""
from __future__ import annotations

import random


# ---------- 基准 ----------
def buy_and_hold(prices, initial_equity: float = 10000.0) -> dict:
    """满仓买入持有的基准权益曲线 + 统计。"""
    ps = [float(p) for p in prices if p]
    if len(ps) < 2 or not ps[0]:
        return {"total_return_pct": 0.0, "max_drawdown_pct": 0.0, "equity_curve": []}
    base = ps[0]
    curve, peak, max_dd = [], initial_equity, 0.0
    for p in ps:
        eq = initial_equity * (p / base)
        peak = max(peak, eq)
        max_dd = max(max_dd, (peak - eq) / peak * 100.0)
        curve.append(round(eq, 2))
    return {"total_return_pct": round((ps[-1] / base - 1) * 100.0, 2),
            "max_drawdown_pct": round(max_dd, 2), "equity_curve": curve}


def random_signals(n: int, seed: int = 0, p_long: float = 0.1, p_short: float = 0.1) -> list:
    """随机信号 null 对照:每根 bar 以 p_long/p_short 概率给 +1/−1,否则 0。种子固定→可复现。"""
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        u = rng.random()
        out.append(1 if u < p_long else -1 if u < p_long + p_short else 0)
    return out


# ---------- 通用信号构造器(逐 bar {-1,0,+1}) ----------
def sign_signal(values, deadband: float = 0.0) -> list:
    """按值符号:v>deadband→+1,v<−deadband→−1,否则 0。None 记 0。"""
    return [1 if (v is not None and v > deadband) else -1 if (v is not None and v < -deadband) else 0 for v in values]


def threshold_signal(values, hi: float, lo: float) -> list:
    """双阈值:v>hi→+1,v<lo→−1,否则 0。"""
    return [1 if (v is not None and v > hi) else -1 if (v is not None and v < lo) else 0 for v in values]


def ma_cross_signal(prices, fast: int = 5, slow: int = 20) -> list:
    """均线状态:fast SMA > slow SMA → +1,< → −1,未成形/相等 → 0。逐 bar 只用 ≤t 数据(无前视)。"""
    n = len(prices)
    out = [0] * n
    for i in range(n):
        if i + 1 < slow:
            continue
        f = sum(prices[i - fast + 1:i + 1]) / fast
        s = sum(prices[i - slow + 1:i + 1]) / slow
        out[i] = 1 if f > s else -1 if f < s else 0
    return out


def _selftest():
    # buy_and_hold
    bh = buy_and_hold([100, 110])
    assert abs(bh["total_return_pct"] - 10.0) < 1e-6 and len(bh["equity_curve"]) == 2
    bh2 = buy_and_hold([100, 120, 90])   # 峰值 120 → 回撤 (120-90)/120=25%
    assert abs(bh2["max_drawdown_pct"] - 25.0) < 1e-6

    # random 可复现 + 取值域
    a = random_signals(50, seed=42)
    assert a == random_signals(50, seed=42) and set(a) <= {-1, 0, 1} and len(a) == 50

    # sign / threshold
    assert sign_signal([0.5, -0.3, 0, None], deadband=0.1) == [1, -1, 0, 0]
    assert threshold_signal([2, -2, 0], hi=1, lo=-1) == [1, -1, 0]

    # ma_cross:前 slow-1 根为 0;上升序列 fast>slow → +1
    mc = ma_cross_signal(list(range(1, 21)), fast=3, slow=5)   # 严格递增 → 近端 fast>slow
    assert mc[:4] == [0, 0, 0, 0] and mc[-1] == 1
    print("strategy_signals selftest: ALL PASS")


if __name__ == "__main__":
    _selftest()
