#!/usr/bin/env python3
"""探针2:13F 可行性。重点①有没有服务端按 cusip 过滤/定位的办法(范围/枚举/排序)——
有则每股票直接查、A 变轻;②max limit;③单季度全量吞吐(时间盒采样,估全扫时长)。只读。"""
import os
import time

import requests

KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
H = {"Authorization": f"Bearer {KEY}"}
EP = "/stocks/filings/vX/13-F"
AMD = "007903107"


def get(**p):
    p.setdefault("apiKey", KEY)
    return requests.get(f"{BASE}{EP}", params=p, headers=H, timeout=45)


def cusips(r):
    try:
        return [x.get("cusip") for x in (r.json().get("results") or [])]
    except Exception:  # noqa: BLE001
        return ["<err>"]


print(f"BASE={BASE} key={'set' if KEY else 'MISSING'}\n")

# ① 服务端按 cusip 过滤/定位?(命中=返回的都是 AMD cusip 007903107)
print("== ① 服务端按证券过滤/定位 ==")
for label, p in [
    ("cusip.any_of", {"cusip.any_of": AMD, "limit": 5}),
    ("cusip.gte+lte(范围)", {"cusip.gte": AMD, "cusip.lte": AMD, "limit": 5}),
    ("sort=cusip 定位(cusip.gte 起点)", {"cusip.gte": AMD, "sort": "cusip", "order": "asc", "limit": 5}),
    ("sort=cusip 仅排序", {"sort": "cusip", "order": "asc", "limit": 5}),
    ("issuer_name", {"issuer_name": "ADVANCED MICRO DEVICES", "limit": 5}),
]:
    try:
        r = get(**p)
        cs = cusips(r) if r.status_code == 200 else []
        hit = bool(cs) and all(c == AMD for c in cs)
        print(f"  {label:32} HTTP {r.status_code}  返回cusip={cs}  {'✅命中AMD' if hit else '✗未过滤/无效'}")
    except Exception as e:  # noqa: BLE001
        print(f"  {label:32} ERR {str(e)[:80]}")

# ② max limit
print("\n== ② max limit ==")
for lim in [1000, 10000, 50000]:
    try:
        r = get(period="2026-06-30", limit=lim)
        n = len(r.json().get("results") or []) if r.status_code == 200 else 0
        print(f"  limit={lim:6} HTTP {r.status_code}  实返 {n}")
    except Exception as e:  # noqa: BLE001
        print(f"  limit={lim:6} ERR {str(e)[:80]}")

# ③ 单季度全量吞吐(≤90s 时间盒;看拉到多少、是否到底、速率)
print("\n== ③ 单季度(2026-06-30)全量吞吐,时间盒 90s ==")
url, rows, pages, t0 = f"{BASE}{EP}?period=2026-06-30&limit=1000&apiKey={KEY}", 0, 0, time.time()
exhausted = False
while url and time.time() - t0 < 90:
    d = requests.get(url, headers=H, timeout=45).json()
    rows += len(d.get("results") or [])
    pages += 1
    nxt = d.get("next_url")
    if not nxt:
        exhausted = True
        break
    url = (nxt + (f"&apiKey={KEY}" if "apiKey" not in nxt else ""))
el = time.time() - t0
print(f"  {pages} 页 · {rows} 行 · {el:.0f}s · {'✅已到底(季度总量='+str(rows)+')' if exhausted else '仍有更多(≥'+str(rows)+' 行)'}")
if not exhausted and rows:
    print(f"  速率 ~{rows/el:.0f} 行/s、{pages/el*60:.0f} 页/min;若全季 ~N 行,全扫 ≈ N/{rows/el:.0f} s")
