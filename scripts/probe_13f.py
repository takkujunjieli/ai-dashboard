#!/usr/bin/env python3
"""探针3:13F 整个数据集到底多大?无过滤分页到底(或时间盒 150s),
统计总行数、覆盖的 period 集合、distinct filer 数、AMD(007903107)是否出现。只读。"""
import os
import time

import requests

KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
H = {"Authorization": f"Bearer {KEY}"}
EP = "/stocks/filings/vX/13-F"
AMD = "007903107"

print(f"BASE={BASE}\n== 无过滤全量分页(时间盒 150s,limit=1000)==")
url = f"{BASE}{EP}?limit=1000&apiKey={KEY}"
rows = pages = 0
periods, filers = {}, set()
amd_hits = 0
t0 = time.time()
exhausted = False
while url and time.time() - t0 < 150:
    d = requests.get(url, headers=H, timeout=45).json()
    res = d.get("results") or []
    rows += len(res)
    pages += 1
    for x in res:
        p = x.get("period"); periods[p] = periods.get(p, 0) + 1
        filers.add(x.get("filer_cik"))
        if x.get("cusip") == AMD:
            amd_hits += 1
    nxt = d.get("next_url")
    if not nxt:
        exhausted = True
        break
    url = nxt + (f"&apiKey={KEY}" if "apiKey" not in nxt else "")

el = time.time() - t0
print(f"结果:{pages} 页 · {rows} 行 · {el:.0f}s · {'✅已到底(这就是全量)' if exhausted else '⏱仍有更多(≥ 上述)'}")
print(f"distinct filer_cik: {len(filers)}")
print(f"AMD(007903107)出现次数: {amd_hits}")
print(f"period 分布(top10): {sorted(periods.items(), key=lambda kv: -kv[1])[:10]}")
if not exhausted and rows:
    print(f"速率 ~{rows/el:.0f} 行/s;若要全扫,需 总行数/速率 秒")
