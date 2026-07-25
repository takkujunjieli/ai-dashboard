#!/usr/bin/env python3
"""PR5(TODO #10):可插拔信号接口 + 真日线对齐 → 回测 → data/strategy_bt.json。

读 `data/gex_daily.json`(每(日,票):`spot` + `net_flow`/`net_nom`/`pcr_*`/`atm_iv`/
`skew_rr`/… ),对单票**按日期升序对齐**成"价格(spot,真日线)+ 特征"上下文,
从 `strategy_signals.SIGNALS` 注册表**按名字选信号**(env `SIG`,默认 `flow_sign`)生成逐 bar
信号,调 `strategy_backtest.run_backtest`(默认含成本 + entry_lag 无前视),再算
`strategy_metrics` 指标 + `buy_and_hold` 基准,写 `data/strategy_bt.json`(供 strategy.html)。

不再硬编码任何信号 —— 换信号只需换 `SIG`;换指标只需在注册表加一条。
⚠️ 默认信号/参数未经验证;结论待 PR6 walk-forward/OOS + IC 研究。
纯 stdlib、只读、无 API/key。env: `SYM` · `SIG` · `BT_TP`/`BT_SL`/`BT_HOLD`。
"""
import json
import os
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from strategy_backtest import run_backtest      # noqa: E402
from strategy_metrics import compute_metrics     # noqa: E402
from strategy_signals import SIGNALS, make_signals, buy_and_hold  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
GD = os.environ.get("GEX_DAILY", str(ROOT / "data" / "gex_daily.json"))
SIG = os.environ.get("SIG", "flow_sign")
TP = float(os.environ.get("BT_TP", "2.0"))
SL = float(os.environ.get("BT_SL", "1.0"))
HOLD = int(os.environ.get("BT_HOLD", "16"))
FEATS = ("net_flow", "net_nom", "pcr_vol", "pcr_oi", "atm_iv", "skew_rr", "iv_term", "vrp", "maxpain_pin", "coverage")


def build_context(gd: dict, sym: str) -> dict:
    """gex_daily {date:{sym:rec}} → 单票按日期升序的上下文;价格=spot(真日线),特征按同一日期对齐。"""
    dates = sorted(d for d in gd if isinstance(gd.get(d), dict) and (gd[d].get(sym) or {}).get("spot"))
    recs = [gd[d][sym] for d in dates]
    return {"sym": sym, "dates": dates, "prices": [float(r["spot"]) for r in recs],
            "feat": {f: [r.get(f) for r in recs] for f in FEATS}}


def _pick_sym(gd: dict):
    c = Counter()
    for day in gd.values():
        if isinstance(day, dict):
            for s, rec in day.items():
                if (rec or {}).get("spot"):
                    c[s] += 1
    return c.most_common(1)[0][0] if c else None


def main():
    gd = json.load(open(GD))
    sym = os.environ.get("SYM") or _pick_sym(gd)
    if not sym:
        print("gex_daily 为空"); return
    if SIG not in SIGNALS:
        print(f"未知信号 {SIG};可选:{list(SIGNALS)}"); return
    ctx = build_context(gd, sym)
    if len(ctx["prices"]) < 5:
        print(f"数据不足(sym={sym}, n={len(ctx['prices'])});先攒 gex_daily"); return

    signals = make_signals(SIG, ctx)
    res = run_backtest(ctx["prices"], signals, ctx["dates"], take_profit_pct=TP, stop_loss_pct=SL, max_holding_bars=HOLD)
    metrics = compute_metrics(res, ann_factor=252)   # 日线 → 252
    bh = buy_and_hold(ctx["prices"])
    out = {
        "sym": sym, "signal": SIG, "signal_desc": SIGNALS[SIG]["desc"], "n_bars": len(ctx["prices"]),
        "source": "data/gex_daily.json(日线 spot + 特征)",
        "caveat": "示例信号/参数,未验证;含成本+无前视。结论待 PR6 walk-forward/OOS + IC 研究。",
        "available_signals": list(SIGNALS),
        **{k: res[k] for k in ("total_trades", "win_rate", "total_return_pct", "max_drawdown_pct",
                               "take_profit_pct", "stop_loss_pct", "max_holding_bars", "allow_short",
                               "cost_bps", "entry_lag")},
        "metrics": metrics,
        "benchmark": {"name": "buy_and_hold", "total_return_pct": bh["total_return_pct"],
                      "max_drawdown_pct": bh["max_drawdown_pct"]},
        "equity_curve": res["equity_curve"], "trades": res["trades"],
    }
    outp = ROOT / "data" / "strategy_bt.json"
    outp.parent.mkdir(exist_ok=True)
    outp.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"{sym} [{SIG}]: n={len(ctx['prices'])} trades={res['total_trades']} net={res['total_return_pct']}% "
          f"sharpe={metrics['sharpe']} vs B&H {bh['total_return_pct']}% → {outp}")


if __name__ == "__main__":
    main()
