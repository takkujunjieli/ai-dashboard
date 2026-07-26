#!/usr/bin/env python3
"""SPX 策略页 producer:SqueezeMetrics 免费数据 → ①研究结论(净 GEX→次日已实现波动,已验证)
+ ②真回测(DIX 方向信号,SPX 3800 天,含 walk-forward OOS),写 data/strategy_bt.json
供 strategy.html(上半研究、下半回测)。

- 数据:https://squeezemetrics.com/monitor/static/DIX.csv(date,price=SPX收盘,dix,gex,免费)。
- 由采集(CI,有网)里 fetch_research 的 hook 调用;**每天最多算一次**(别每轮拉外网);失败不影响采集。
- 纯 stdlib。测试可用 SQZ_CSV=本地路径 绕过拉网。
"""
import csv
import json
import os
import statistics as st
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from strategy_backtest import run_backtest       # noqa: E402
from strategy_metrics import compute_metrics      # noqa: E402
from strategy_signals import buy_and_hold         # noqa: E402
from strategy_walkforward import walk_forward     # noqa: E402
from research_gex_vol import study                # noqa: E402  复用研究口径

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "strategy_bt.json"
SQZ_LOCAL = os.environ.get("SQZ_CSV")
SQZ_URL = "https://squeezemetrics.com/monitor/static/DIX.csv"


def load_spx():
    if SQZ_LOCAL:
        rows = list(csv.DictReader(open(SQZ_LOCAL)))
    else:
        with urllib.request.urlopen(SQZ_URL, timeout=30) as r:
            rows = list(csv.DictReader(line.decode() for line in r))
    rows = [r for r in rows if r.get("gex") and r.get("price") and r.get("dix")]
    rows.sort(key=lambda r: r["date"])
    return ([r["date"] for r in rows], [float(r["price"]) for r in rows],
            [float(r["gex"]) for r in rows], [float(r["dix"]) for r in rows])


def dix_signal(dix, win=60):
    """DIX 方向示例:DIX 高于过去 win 日中位 → 做多(暗池吸筹),低于 → 做空。逐 bar 只用 <i 数据。"""
    sig = [0] * len(dix)
    for i in range(win, len(dix)):
        med = st.median(dix[i - win:i])
        sig[i] = 1 if dix[i] > med else -1
    return sig


def main():
    today = datetime.now(timezone.utc).date().isoformat()
    if not SQZ_LOCAL and OUT.exists():   # 今天已算过 → 跳过(每天一次)
        try:
            if json.loads(OUT.read_text()).get("asof", "")[:10] == today:
                return
        except Exception:  # noqa: BLE001
            pass

    dates, price, gex, dix = load_spx()
    res_study = study(dates, price, gex, label="SPX 净 GEX → 次日已实现波动")

    sig = dix_signal(dix)
    r = run_backtest(price, sig, dates, take_profit_pct=3, stop_loss_pct=2, max_holding_bars=10)
    m = compute_metrics(r, ann_factor=252)
    bh = buy_and_hold(price)
    bench_curve = [{"t": d, "equity": e} for d, e in zip(dates, bh["equity_curve"])]
    wf = walk_forward(price, sig, dates, grid={"take_profit_pct": [2, 3, 4], "stop_loss_pct": [1, 2, 3],
                                               "max_holding_bars": [5, 10, 20]}, train=252, test=63)
    out = {
        "asof": today, "sym": "SPX", "signal": "dix_dir",
        "signal_desc": "DIX 高于过去60日中位→做多、低于→做空(SqueezeMetrics 暗池方向,示例)",
        "source": "SqueezeMetrics DIX.csv(SPX 日频,免费)",
        "caveat": "上方研究为已验证机制(净 GEX→次日波动);下方交易回测的 DIX 方向信号仅示例,以 OOS 为准。",
        "study": res_study,
        **{k: r[k] for k in ("total_trades", "win_rate", "total_return_pct", "max_drawdown_pct",
                             "take_profit_pct", "stop_loss_pct", "max_holding_bars", "allow_short",
                             "cost_bps", "entry_lag")},
        "n_bars": len(price), "metrics": m,
        "benchmark": {"name": "buy_and_hold", "total_return_pct": bh["total_return_pct"],
                      "max_drawdown_pct": bh["max_drawdown_pct"], "equity_curve": bench_curve},
        "equity_curve": r["equity_curve"], "trades": r["trades"][-200:],   # 交易多,表格截尾
    }
    if wf["n_folds"] > 0:
        out["oos"] = {k: v for k, v in wf.items() if k != "oos_equity_curve"}   # 页面不用整条曲线,省体积
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"SPX: study Spearman={res_study.get('spearman')} 区制{res_study.get('regime',{}).get('ratio')}x | "
          f"回测 {r['total_trades']}笔 net={r['total_return_pct']}% vs B&H {bh['total_return_pct']}% OOS={wf['n_folds']}折")


if __name__ == "__main__":
    main()
