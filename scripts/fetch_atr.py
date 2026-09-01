#!/usr/bin/env python3
"""为本地持仓算 ATR14(Yahoo 日线,免 key),供 strategy 页「风险敞口」的 ATR 止损。
读 data/portfolio.json 的持仓 sym(仅 equity),写 data/atr.json(本地专用,已 gitignore)。
本地跑:python3 scripts/fetch_atr.py(ATR14 变化慢,隔几天跑一次即可)。"""
import json
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
PF = ROOT / "data" / "portfolio.json"
OUT = ROOT / "data" / "atr.json"
UA = {"User-Agent": "Mozilla/5.0"}


def daily(sym):
    u = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=3mo&interval=1d"
    r = requests.get(u, headers=UA, timeout=30)
    r.raise_for_status()
    q = r.json()["chart"]["result"][0]["indicators"]["quote"][0]
    return q["high"], q["low"], q["close"]


def atr14(h, l, c):
    """Wilder TR 的近 14 日均值(够用);缺值跳过。"""
    trs = []
    for i in range(1, len(c)):
        if None in (h[i], l[i], c[i], c[i - 1]):
            continue
        trs.append(max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1])))
    return round(sum(trs[-14:]) / min(len(trs), 14), 4) if trs else None


def main():
    if not PF.exists():
        print("缺 data/portfolio.json(本地专用);先刷新持仓"); return
    pf = json.loads(PF.read_text())
    syms = sorted({p["sym"] for p in pf.get("positions", [])
                   if p.get("kind") == "equity" and " " not in p.get("sym", "")})
    out = {}
    for s in syms:
        try:
            out[s] = atr14(*daily(s))
            print(f"{s}: ATR14={out[s]}")
        except Exception as e:
            print(f"{s} 失败: {e}")
    OUT.write_text(json.dumps({"updated": time.strftime("%Y-%m-%dT%H:%M:%S"), "atr14": out}, ensure_ascii=False))
    print(f"→ {OUT.relative_to(ROOT)} ({len(out)} 只)")


if __name__ == "__main__":
    main()
