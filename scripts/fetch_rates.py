#!/usr/bin/env python3
"""抓过去 ~5 年日频:US 10/30yr 收益率(FRED,免 key)+ SPY/QQQ/IWM 价格(Yahoo)。
→ data/rates.json,供 strategy 页聚合折线图。纯 stdlib。

FRED 用 fredgraph.csv 端点(无需 API key);Yahoo 用 v8/finance/chart JSON。"""
import json
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UA = {"User-Agent": "Mozilla/5.0 (research-dashboard rates fetch)"}
YEARS = 5

now = datetime.now(timezone.utc)
start = (now - timedelta(days=365 * YEARS + 5)).strftime("%Y-%m-%d")
end = now.strftime("%Y-%m-%d")


def _get(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def fred_series(sid):
    """FRED fredgraph.csv → [[YYYY-MM-DD, value], ...],跳过缺失('.')。"""
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd={start}&coed={end}"
    out = []
    for line in _get(url).splitlines()[1:]:            # 跳表头 DATE,<sid>
        parts = line.split(",")
        if len(parts) < 2:
            continue
        d, v = parts[0].strip(), parts[1].strip()
        if v in ("", ".", "NaN"):
            continue
        try:
            out.append([d, round(float(v), 4)])
        except ValueError:
            continue
    return out


def yahoo_series(sym):
    """Yahoo v8 chart(range=5y,1d)→ [[YYYY-MM-DD, adjclose], ...]。"""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range={YEARS}y&interval=1d"
    d = json.loads(_get(url))
    res = d["chart"]["result"][0]
    ts = res["timestamp"]
    ind = res["indicators"]
    adj = (ind.get("adjclose") or [{}])[0].get("adjclose")
    close = ind["quote"][0]["close"]
    vals = adj if adj else close
    out = []
    for t, v in zip(ts, vals):
        if v is None:
            continue
        day = datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d")
        out.append([day, round(float(v), 4)])
    return out


series, errors = {}, []
for label, fn, arg in [
    ("DGS2", fred_series, "DGS2"), ("DGS10", fred_series, "DGS10"), ("DGS30", fred_series, "DGS30"),
    ("SPY", yahoo_series, "SPY"), ("QQQ", yahoo_series, "QQQ"), ("IWM", yahoo_series, "IWM"),
]:
    try:
        series[label] = fn(arg)
        print(f"{label}: {len(series[label])} 点  {series[label][0][0]}→{series[label][-1][0]}")
    except Exception as e:  # 单源失败不影响其他
        errors.append(f"{label}: {e}")
        print(f"{label} 失败: {e}")

out = {
    "updated_at": now.isoformat(timespec="seconds"),
    "range_years": YEARS,
    # meta:画图用。yields=右轴(实际%);equities=左轴(归一到100)。IWM=Russell 2000 ETF。
    "meta": {
        "DGS2": {"label": "US 2Y", "axis": "yield", "color": "#fbbf24"},
        "DGS10": {"label": "US 10Y", "axis": "yield", "color": "#f59e0b"},
        "DGS30": {"label": "US 30Y", "axis": "yield", "color": "#ef4444"},
        "SPY": {"label": "SPY", "axis": "equity", "color": "#60a5fa"},
        "QQQ": {"label": "QQQ", "axis": "equity", "color": "#a78bfa"},
        "IWM": {"label": "Russell 2000 (IWM)", "axis": "equity", "color": "#34d399"},
    },
    "series": series,
    "errors": errors,
}
(DATA / "rates.json").write_text(json.dumps(out, ensure_ascii=False))
print(f"→ data/rates.json ({sum(len(v) for v in series.values())} 点合计)")
