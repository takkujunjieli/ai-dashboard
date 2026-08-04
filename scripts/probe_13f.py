#!/usr/bin/env python3
"""探针4:按 filer_cik 查单个大机构——决定 Option B 可行性。
每家报:持仓行数、覆盖的 period(历史深度)、是否含 AMD。只读。"""
import os

import requests

KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
H = {"Authorization": f"Bearer {KEY}"}
EP = "/stocks/filings/vX/13-F"
AMD = "007903107"
FILERS = {
    "Berkshire Hathaway": "0001067983",
    "Vanguard Group": "0000102909",
    "BlackRock": "0001364742",
    "Renaissance Tech": "0001037389",
    "State Street": "0000093751",
}

print(f"BASE={BASE}\n")
for name, cik in FILERS.items():
    url = f"{BASE}{EP}?filer_cik={cik}&limit=1000&apiKey={KEY}"
    rows, pages, periods, amd = 0, 0, {}, 0
    while url and pages < 6:
        try:
            d = requests.get(url, headers=H, timeout=45).json()
        except Exception as e:  # noqa: BLE001
            print(f"{name:20} ERR {str(e)[:70]}"); break
        res = d.get("results") or []
        rows += len(res); pages += 1
        for x in res:
            periods[x.get("period")] = periods.get(x.get("period"), 0) + 1
            if x.get("cusip") == AMD:
                amd += 1
        nxt = d.get("next_url")
        if not nxt:
            break
        url = nxt + (f"&apiKey={KEY}" if "apiKey" not in nxt else "")
    ps = sorted([p for p in periods if p], reverse=True)
    print(f"{name:20} rows={rows:5}  periods={len(ps)} {ps[:6]}  AMD持仓={amd}")
