#!/usr/bin/env python3
"""抓 QQQ / SOXX / IGV 的周 K(OHLC),供 research 仓位情报的 cohort z 分数图叠加(可开关)。
Yahoo v8 chart(range=3y,interval=1wk,拆股调整)→ data/etf_weekly.json。纯 stdlib、免 key。
浏览器直连 Yahoo 会被 CORS 挡,所以在服务端抓好写成 JSON,前端只读。"""
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "etf_weekly.json"
SYMS = ["QQQ", "SOXX", "IGV"]
YEARS = 3


def weekly_ohlc(sym):
    """Yahoo v8 chart(周频)→ [[YYYY-MM-DD, open, high, low, close], ...](拆股调整)。"""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range={YEARS}y&interval=1wk"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read())
    res = d["chart"]["result"][0]
    ts = res["timestamp"]
    q = res["indicators"]["quote"][0]
    o, h, l, c = q["open"], q["high"], q["low"], q["close"]
    out = []
    for i, t in enumerate(ts):
        if None in (o[i], h[i], l[i], c[i]):
            continue
        day = time.strftime("%Y-%m-%d", time.gmtime(t))
        out.append([day, round(o[i], 2), round(h[i], 2), round(l[i], 2), round(c[i], 2)])
    return out


def main():
    series, errors = {}, []
    for s in SYMS:
        try:
            series[s] = weekly_ohlc(s)
            print(f"{s}: {len(series[s])} 周 bar(最新 {series[s][-1][0]} = {series[s][-1][4]})")
        except Exception as e:  # noqa: BLE001
            errors.append(f"{s}: {e}")
            print(f"{s} 失败: {e}")
    OUT.write_text(json.dumps({"updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                               "range_years": YEARS, "series": series, "errors": errors},
                              ensure_ascii=False))
    print(f"→ {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
