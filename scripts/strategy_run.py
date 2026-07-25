#!/usr/bin/env python3
"""PR2(TODO #10):把真实信号喂给回测引擎,离线跑一条权益曲线 + 统计。

读 `data/flow_history.json`(前向记录器,每轮每票:`t`=时间/`s`=符号/`p`=spot/
`fn`=真 flow-GEX 净/`nn`=名义净/`cov`…),对单只票构造"价格序列(p)+ 逐 bar 信号",
调用 `strategy_backtest.run_backtest`,把结果写 `data/strategy_bt.json`(供 PR3 静态页渲染)。

⚠️ **这是管线打通用的示例,不是已验证策略**:所选信号(flow-GEX 符号顺势做多/空标的)
已被 pilot 判为**不具预测力**(见 docs/backtest-flow-gamma-pilot.md),这里只为跑通
"真数据 → 引擎 → 结果 JSON"。策略有效性留给 PR4(walk-forward 寻优)+ 现有 IC 研究。

纯 stdlib、只读、无需 API/key。flow_history 在 data 分支:
  git fetch origin data && git show origin/data:data/flow_history.json > data/flow_history.json
env: SYM(默认点数最多的票)· SIG(fn|nn,默认 fn)· BT_TP(2.0)· BT_SL(1.0)· BT_HOLD(16)
"""
import json
import os
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from strategy_backtest import run_backtest  # noqa: E402  同目录模块

ROOT = Path(__file__).resolve().parent.parent
FH = os.environ.get("FLOW_HISTORY", str(ROOT / "data" / "flow_history.json"))
SIG_FIELD = os.environ.get("SIG", "fn")          # 定方向的流字段:fn=真 flow-GEX / nn=名义净
TP = float(os.environ.get("BT_TP", "2.0"))
SL = float(os.environ.get("BT_SL", "1.0"))
HOLD = int(os.environ.get("BT_HOLD", "16"))


def load_series(sym=None):
    """返回 (sym, 按时间升序的该票点列表)。sym=None → 选点数最多的票。"""
    pts = json.load(open(FH)).get("points") or []
    if not pts:
        return None, []
    if sym is None:
        sym = Counter(p["s"] for p in pts if p.get("s")).most_common(1)[0][0]
    rows = sorted((p for p in pts if p.get("s") == sym and p.get("p")), key=lambda p: p["t"])
    return sym, rows


def main():
    sym, rows = load_series(os.environ.get("SYM"))
    if len(rows) < 5:
        print(f"数据不足(sym={sym}, n={len(rows)});先让 flow_history 多攒几轮再跑")
        return
    prices = [float(r["p"]) for r in rows]
    times = [r["t"] for r in rows]
    # 信号:客户净买(流为正)→ 顺势做多标的,净卖→做空。**示例方向,非验证结论**。
    signals = [(1 if (r.get(SIG_FIELD) or 0) > 0 else -1 if (r.get(SIG_FIELD) or 0) < 0 else 0) for r in rows]

    res = run_backtest(prices, signals, times, take_profit_pct=TP, stop_loss_pct=SL, max_holding_bars=HOLD)
    out = {
        "sym": sym, "signal": SIG_FIELD, "n_bars": len(rows),
        "signal_desc": f"sign({SIG_FIELD}) 顺势做多/空标的(示例,未验证)",
        "source": "data/flow_history.json(前向记录器)",
        "caveat": "管线打通示例;所选信号 pilot 已判无预测力,勿当策略结论。有效性见 PR4 + IC 研究。",
        **{k: res[k] for k in ("total_trades", "win_rate", "total_return_pct", "max_drawdown_pct",
                               "take_profit_pct", "stop_loss_pct", "max_holding_bars", "allow_short")},
        "equity_curve": res["equity_curve"], "trades": res["trades"],
    }
    outp = ROOT / "data" / "strategy_bt.json"
    outp.parent.mkdir(exist_ok=True)
    outp.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"{sym}: bars={len(rows)} trades={res['total_trades']} win={res['win_rate']}% "
          f"ret={res['total_return_pct']}% maxDD={res['max_drawdown_pct']}% → {outp}")


if __name__ == "__main__":
    main()
