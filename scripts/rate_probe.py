#!/usr/bin/env python3
"""网关限流探针:对期权 REST 和股票 REST 端点做递增并发突发,数 200/429,
测出真实每分钟上限,以及期权/股票是否共用一个 REST 桶。突发间隔 65s 让窗口重置。"""
import os
import time
from concurrent.futures import ThreadPoolExecutor

import requests

KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")

STOCK = f"{BASE}/v2/aggs/ticker/AMD/prev"          # 极小载荷
OPT = f"{BASE}/v3/snapshot/options/AMD"            # limit=1 只取 1 合约,载荷小
BURSTS = [30, 60, 120, 200]


def one(url, params):
    try:
        r = requests.get(url, params=params, timeout=30)
        return r.status_code
    except Exception:  # noqa: BLE001
        return -1


def burst(label, url, params, n):
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=30) as ex:
        codes = list(ex.map(lambda _: one(url, params), range(n)))
    dt = time.time() - t0
    ok = codes.count(200)
    r429 = codes.count(429)
    other = n - ok - r429
    rate = ok / dt * 60 if dt else 0
    print(f"  {label} 突发{n}: 200={ok} 429={r429} 其他={other} | 用时{dt:.1f}s 成功速率≈{rate:.0f}/min")
    return ok, r429


def ramp(label, url, params):
    print(f"== {label} ==")
    for i, n in enumerate(BURSTS):
        if i:
            time.sleep(65)  # 等限流窗口重置
        burst(label, url, params, n)


def mixed():
    """期权+股票各 120 并发同时打,看是否共用一个桶(共用则合计 429 更早出现)。"""
    print("== 混合(期权120 + 股票120 同时) ==")
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=40) as ex:
        futs = [ex.submit(one, OPT, {"apiKey": KEY, "limit": 1}) for _ in range(120)] + \
               [ex.submit(one, STOCK, {"apiKey": KEY}) for _ in range(120)]
        codes = [f.result() for f in futs]
    dt = time.time() - t0
    print(f"  合计240: 200={codes.count(200)} 429={codes.count(429)} 其他={240 - codes.count(200) - codes.count(429)} | 用时{dt:.1f}s")


def main():
    ramp("期权REST", OPT, {"apiKey": KEY, "limit": 1})
    time.sleep(65)
    ramp("股票REST", STOCK, {"apiKey": KEY})
    time.sleep(65)
    mixed()


if __name__ == "__main__":
    main()
