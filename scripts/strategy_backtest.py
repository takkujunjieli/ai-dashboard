#!/usr/bin/env python3
"""信号无关的交易回测引擎(纯 Python,无 pandas)。PR1(见 TODO #10)。

移植自 Playground 的 run_backtest,但去掉对"机构流信号 / CMF / pandas"的耦合:
- 引擎只认**每根 bar 的入场信号方向**(+1 开多 / −1 开空 / 0 无),不关心信号怎么来;
- **close-to-close** 模拟:开仓后按收盘价相对入场价的收益判 TP/SL,或持仓超时退出;
- **单持仓、一次一笔**(持仓中忽略新信号,与 Playground 一致);
- **复利权益**,记录逐笔交易 + 逐 bar 盯市权益曲线 + 胜率/总收益/最大回撤。

后续 PR:PR2 用真实信号(flow_history/gex_daily)喂它;PR3 静态页展示;PR4 加 walk-forward 寻优。
本模块不依赖任何第三方库,可 `python scripts/strategy_backtest.py` 直接跑自检。
"""
from __future__ import annotations


def run_backtest(prices, signals, times=None, *,
                 take_profit_pct: float = 2.0, stop_loss_pct: float = 1.0,
                 max_holding_bars: int = 16, allow_short: bool = True,
                 initial_equity: float = 10000.0) -> dict:
    """在给定价格序列 + 入场信号上模拟交易。

    prices:  list[float]  每根 bar 的收盘价(时序升序)。
    signals: list[int]    同长度;每根 bar 的入场信号:+1=开多,−1=开空,0=无。**仅空仓时用于入场**。
    times:   list|None    可选,长度同 prices,用于交易/权益曲线的时间标注(需可 JSON 序列化);缺省用下标。
    退出:开仓后 close 相对 entry 收益 ≥ take_profit_pct → take_profit;≤ −stop_loss_pct → stop_loss;
          持仓 bar 数 ≥ max_holding_bars → time_limit。
    返回:{total_trades, win_rate, total_return_pct, max_drawdown_pct, trades[], equity_curve[], 参数...}。
    注:**末尾未平仓的一笔不计入** total_return/胜率(与 Playground 一致);权益曲线末点为盯市浮盈。
    """
    n = len(prices)
    params = {"take_profit_pct": take_profit_pct, "stop_loss_pct": stop_loss_pct,
              "max_holding_bars": max_holding_bars, "allow_short": allow_short}
    if n == 0 or len(signals) != n:
        return {"total_trades": 0, "win_rate": 0.0, "total_return_pct": 0.0,
                "max_drawdown_pct": 0.0, "trades": [], "equity_curve": [], **params}
    lbl = times if (times is not None and len(times) == n) else list(range(n))

    trades: list = []
    curve: list = []
    position = None          # None / "LONG" / "SHORT"
    entry_price = 0.0
    entry_i = 0
    equity = float(initial_equity)
    peak = equity
    max_dd = 0.0

    def open_ret(px: float) -> float:  # 当前持仓的浮动收益 %
        if position == "LONG":
            return (px - entry_price) / entry_price * 100.0
        return (entry_price - px) / entry_price * 100.0

    for i in range(n):
        px = float(prices[i])

        # 1) 持仓中:判退出(close-to-close)
        if position is not None and entry_price > 0:
            ret = open_ret(px)
            held = i - entry_i
            reason = ("take_profit" if ret >= take_profit_pct
                      else "stop_loss" if ret <= -stop_loss_pct
                      else "time_limit" if held >= max_holding_bars else None)
            if reason:
                trades.append({"entry_time": lbl[entry_i], "exit_time": lbl[i],
                               "type": position, "entry_price": entry_price, "exit_price": px,
                               "return_pct": round(ret, 4), "bars_held": held, "reason": reason})
                equity *= (1 + ret / 100.0)
                peak = max(peak, equity)
                max_dd = max(max_dd, (peak - equity) / peak * 100.0)
                position = None

        # 2) 空仓:按信号入场(同 bar 退出后可立即再进,与 Playground 一致)
        if position is None and px > 0:
            s = signals[i]
            if s == 1:
                position, entry_price, entry_i = "LONG", px, i
            elif s == -1 and allow_short:
                position, entry_price, entry_i = "SHORT", px, i

        # 3) 逐 bar 盯市权益(含未平仓浮盈)
        mtm = equity * (1 + open_ret(px) / 100.0) if (position and entry_price > 0) else equity
        curve.append({"t": lbl[i], "equity": round(mtm, 2), "position": position or "FLAT"})

    total_ret = (equity - initial_equity) / initial_equity * 100.0
    wins = sum(1 for t in trades if t["return_pct"] > 0)
    win_rate = (wins / len(trades) * 100.0) if trades else 0.0
    return {"total_trades": len(trades), "win_rate": round(win_rate, 2),
            "total_return_pct": round(total_ret, 2), "max_drawdown_pct": round(max_dd, 2),
            "trades": trades, "equity_curve": curve, **params}


def _selftest() -> None:
    ap = lambda a, b: abs(a - b) < 1e-6  # noqa: E731

    # 多头止盈:100→102 触发 tp=2
    r = run_backtest([100, 101, 102, 103], [1, 0, 0, 0], take_profit_pct=2, stop_loss_pct=1)
    assert r["total_trades"] == 1 and r["trades"][0]["reason"] == "take_profit"
    assert ap(r["trades"][0]["return_pct"], 2.0) and ap(r["total_return_pct"], 2.0) and r["win_rate"] == 100.0

    # 多头止损:100→99 触发 sl=1
    r = run_backtest([100, 99, 98], [1, 0, 0], take_profit_pct=5, stop_loss_pct=1)
    assert r["trades"][0]["reason"] == "stop_loss" and ap(r["trades"][0]["return_pct"], -1.0)

    # 超时退出:横盘,max_holding=2
    r = run_backtest([100, 100, 100, 100], [1, 0, 0, 0], take_profit_pct=5, stop_loss_pct=5, max_holding_bars=2)
    assert r["trades"][0]["reason"] == "time_limit" and r["trades"][0]["bars_held"] == 2

    # 空头止盈:100→98 触发 tp=2
    r = run_backtest([100, 99, 98], [-1, 0, 0], take_profit_pct=2, stop_loss_pct=5)
    assert r["trades"][0]["type"] == "SHORT" and r["trades"][0]["reason"] == "take_profit" and ap(r["total_return_pct"], 2.0)

    # 禁空:−1 信号不开仓
    assert run_backtest([100, 99, 98], [-1, 0, 0], allow_short=False)["total_trades"] == 0

    # 无信号:空仓、零收益
    r = run_backtest([100, 101, 102], [0, 0, 0])
    assert r["total_trades"] == 0 and r["total_return_pct"] == 0.0 and r["equity_curve"][-1]["position"] == "FLAT"

    # 回撤:先 +2% 再 −3% → max_dd=3%
    r = run_backtest([100, 102, 100, 97], [1, 0, 1, 0], take_profit_pct=2, stop_loss_pct=1, max_holding_bars=16)
    assert r["total_trades"] == 2 and ap(r["max_drawdown_pct"], 3.0)

    # 边界:空输入 / 长度不匹配
    assert run_backtest([], [])["total_trades"] == 0
    assert run_backtest([100, 101], [1])["total_trades"] == 0

    print("strategy_backtest selftest: ALL PASS")


if __name__ == "__main__":
    _selftest()
