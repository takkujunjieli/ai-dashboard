#!/usr/bin/env python3
"""诊断:网关对并发到底加不加速。对 N 票的期权链快照,分别顺序 vs 并发抓,
比较墙钟时间、总请求数、429 次数。判定并发提速是否被网关限制。只读。"""
import os
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

import requests

KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
HEADERS = {"Authorization": f"Bearer {KEY}"}
SYMS = (os.environ.get("PROBE_SYMS") or "AMD,MU,TSLA,NVDA,COIN,HOOD,CRWD,INTC").split(",")
_429 = 0


def rebase(u):
    p = urlparse(u)
    return f"{BASE}{p.path}" + (f"?{p.query}" if p.query else "")


def get(path):
    global _429
    url = path if path.startswith("http") else f"{BASE}{path}"
    sep = "&" if "?" in url else "?"
    r = requests.get(url + f"{sep}apiKey={KEY}", headers=HEADERS, timeout=40)
    if r.status_code == 429:
        _429 += 1
        r.raise_for_status()
    r.raise_for_status()
    return r.json()


def fetch_chain(sym):
    """抓一票的期权链(分页),返回请求页数。"""
    url, pages = f"/v3/snapshot/options/{sym}?limit=250", 0
    while url and pages < 12:
        d = get(url)
        pages += 1
        url = rebase(d.get("next_url")) if d.get("next_url") else None
    return pages


def run(label, fn):
    global _429
    _429 = 0
    t = time.time()
    pages = fn()
    dt = time.time() - t
    print(f"{label}: {len(SYMS)} 票 / {sum(pages)} 页 / 用时 {dt:.1f}s / 429 次数 {_429} "
          f"/ 有效 {sum(pages)/dt:.1f} 页/s")


def main():
    print(f"BASE={BASE}  SYMS={SYMS}  key={'set' if KEY else 'MISSING'}\n")
    # 顺序
    run("顺序", lambda: [fetch_chain(s) for s in SYMS])
    time.sleep(3)
    # 并发 (workers=len)
    def concur():
        with ThreadPoolExecutor(max_workers=len(SYMS)) as ex:
            return list(ex.map(fetch_chain, SYMS))
    run(f"并发×{len(SYMS)}", concur)


if __name__ == "__main__":
    main()
