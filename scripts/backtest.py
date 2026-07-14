#!/usr/bin/env python3
"""GEX regime 回测:用累积的 data/gex_daily.json(每日 flip/net,名义与流量两版)
配对次日已实现波动,检验"价在 flip 上方=正 gamma=波动更低"是否成立,并比较
名义 flip 与流量 flip 哪个把高/低波动日分得更开(分得越开 = 该版符号越可信)。

窗口:用全部已累积天数;样本 <MIN_DAYS 时标注"数据不足"。价格用 Massive 日线。
GEX 历史无法回溯,只能从本系统开始采集后逐日累积——所以早期样本少、随时间变可信。
"""
import json
import os
import statistics as st
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_research as fr  # noqa: E402  复用 mget/BASE/KEY

ROOT = Path(__file__).resolve().parent.parent
MIN_DAYS = 30  # 少于此样本量不下结论


def daily_bars(sym):
    """近 250 日线 → {date_str: (high, low, close)},用于算次日已实现波动。"""
    to = date.today()
    frm = to.replace(year=to.year - 1)
    data = fr.mget(f"/v2/aggs/ticker/{sym}/range/1/day/{frm}/{to}", adjusted="true", sort="asc", limit=400)
    import datetime as dt
    out = {}
    for r in data.get("results") or []:
        d = dt.datetime.fromtimestamp(r["t"] / 1000, dt.timezone.utc).date().isoformat()
        out[d] = (r["h"], r["l"], r["c"])
    return out


def analyze(rows, label):
    """rows: [(spot, flip, next_range_pct)]。按 spot 相对 flip 分正/负 gamma 区,比较次日波动。"""
    pos = [r[2] for r in rows if r[1] is not None and r[0] >= r[1]]   # 价在 flip 上=正 gamma
    neg = [r[2] for r in rows if r[1] is not None and r[0] < r[1]]    # 价在 flip 下=负 gamma
    n = len(pos) + len(neg)
    print(f"\n== {label} ==  样本 {n}(正gamma {len(pos)} / 负gamma {len(neg)})")
    if n < MIN_DAYS or not pos or not neg:
        print(f"  数据不足(需 ≥{MIN_DAYS} 且两区都有样本),继续累积后再看")
        return
    mp, mn = st.mean(pos), st.mean(neg)
    print(f"  次日已实现波动均值:正gamma区 {mp * 100:.2f}%  负gamma区 {mn * 100:.2f}%")
    print(f"  负/正 比值 {mn / mp:.2f}  (>1 = 负gamma区波动更大,符合理论;越大=该 flip 分得越开)")


def main():
    daily = json.loads((ROOT / "data" / "gex_daily.json").read_text()) if (ROOT / "data" / "gex_daily.json").exists() else {}
    dates = sorted(daily)
    if len(dates) < 2:
        print(f"累积天数 {len(dates)},不足以回测(GEX 历史只能逐日累积,请让系统多跑几天)")
        return
    print(f"累积天数 {len(dates)}:{dates[0]} ~ {dates[-1]}")

    syms = sorted({s for d in daily.values() for s in d})
    bars = {}
    for s in syms:
        try:
            bars[s] = daily_bars(s)
        except Exception as exc:  # noqa: BLE001
            print(f"  {s} 日线失败: {fr.redact(exc)}")
            bars[s] = {}

    nom_rows, flow_rows = [], []
    for i, d in enumerate(dates[:-1]):
        nxt = dates[i + 1]
        for sym, rec in daily[d].items():
            b = bars.get(sym, {}).get(nxt)
            if not b or not rec.get("spot"):
                continue
            hi, lo, _ = b
            nrange = (hi - lo) / rec["spot"]  # 次日 (高-低)/今日spot,已实现波动代理
            if rec.get("flip_nom") is not None:
                nom_rows.append((rec["spot"], rec["flip_nom"], nrange))
            if rec.get("flip_flow") is not None:
                flow_rows.append((rec["spot"], rec["flip_flow"], nrange))

    analyze(nom_rows, "名义 flip 作为波动分界")
    analyze(flow_rows, "流量 flip 作为波动分界")
    print("\n注:比较两者的'负/正比值',更大者说明该版 flip 把高/低波动日分得更开 = 符号更可信。")


if __name__ == "__main__":
    main()
