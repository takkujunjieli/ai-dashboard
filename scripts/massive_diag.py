#!/usr/bin/env python3
"""Massive API 权限诊断:逐个端点打印状态码和数据新鲜度,用于确认套餐生效范围。"""
import json
import os
from datetime import date, datetime, timezone

import requests

KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
H = {"Authorization": f"Bearer {KEY}"}
today = date.today().isoformat()

TESTS = [
    ("reference",        f"/v3/reference/tickers?ticker=TSLA"),
    ("prev close",       f"/v2/aggs/ticker/TSLA/prev"),
    ("今日 1m aggs",      f"/v2/aggs/ticker/TSLA/range/1/minute/{today}/{today}?limit=3&sort=desc"),
    ("snapshot v2 全表",  f"/v2/snapshot/locale/us/markets/stocks/tickers?tickers=TSLA"),
    ("snapshot v2 单票",  f"/v2/snapshot/locale/us/markets/stocks/tickers/TSLA"),
    ("snapshot v3 统一",  f"/v3/snapshot?ticker.any_of=TSLA"),
    ("last trade",       f"/v2/last/trade/TSLA"),
    ("last quote",       f"/v2/last/quote/TSLA"),
    ("options snapshot", f"/v3/snapshot/options/TSLA?limit=1"),
]

print(f"now={datetime.now(timezone.utc).isoformat(timespec='seconds')} base={BASE}")
for name, path in TESTS:
    try:
        r = requests.get(f"{BASE}{path}", headers=H, timeout=30)
        info = ""
        if r.ok:
            body = r.json()
            results = body.get("results")
            if isinstance(results, list) and results and "t" in results[0]:
                ts = datetime.fromtimestamp(results[0]["t"] / 1000, tz=timezone.utc)
                info = f"最新bar={ts.isoformat(timespec='minutes')}"
            else:
                info = json.dumps(body, ensure_ascii=False)[:140]
        else:
            info = r.text[:140]
        print(f"[{r.status_code}] {name}: {info}")
    except Exception as exc:  # noqa: BLE001
        print(f"[ERR] {name}: {exc}")
