#!/usr/bin/env python3
"""一次性探针:自建网关是否支持**指数期权**(SPX/NDX/RUT),返回带不带 OI/greeks/IV,链多大。
用途:判断能否抓 SPX 主池补全"真·指数 GEX"(替换误导的 SPY/QQQ ETF 切片)。
在有 MASSIVE_API_KEY 的环境跑(probeidx.yml)。只读,不写文件。
"""
import os

import requests

KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
H = {"Authorization": f"Bearer {KEY}"}


def get(path, **p):
    p.setdefault("apiKey", KEY)
    url = path if path.startswith("http") else f"{BASE}{path}"
    return requests.get(url, params=p, headers=H, timeout=30)


print(f"BASE={BASE}\n=== snapshot/options(有没有 OI/greeks/IV)===")
for u in ["SPX", "I:SPX", "SPXW", "NDX", "I:NDX", "RUT", "VIX", "SPY"]:   # SPY 作对照(已知可用)
    try:
        r = get(f"/v3/snapshot/options/{u}", limit=250)
        if r.status_code != 200:
            print(f"  {u:8} HTTP {r.status_code}  {r.text[:100]}")
            continue
        d = r.json(); res = d.get("results") or []
        f = res[0] if res else {}
        det = f.get("details") or {}
        print(f"  {u:8} HTTP 200  results={len(res):>4}  next={'Y' if d.get('next_url') else 'N'}  "
              f"OI={f.get('open_interest') is not None} greeks={bool(f.get('greeks'))} "
              f"IV={f.get('implied_volatility') is not None}  例:{det.get('ticker')} k={det.get('strike_price')} exp={det.get('expiration_date')}")
    except Exception as e:  # noqa: BLE001
        print(f"  {u:8} ERR {type(e).__name__}: {str(e)[:110]}")

print("\n=== reference/options/contracts(合约宇宙,估链大小)===")
for u in ["SPX", "NDX"]:
    try:
        r = get("/v3/reference/options/contracts", underlying_ticker=u, limit=5)
        d = r.json() if r.status_code == 200 else {}
        res = d.get("results") or []
        print(f"  {u:6} HTTP {r.status_code}  n(样本)={len(res)}  next={'Y' if d.get('next_url') else 'N'}  例:{res[0].get('ticker') if res else None}")
    except Exception as e:  # noqa: BLE001
        print(f"  {u:6} ERR {str(e)[:100]}")
