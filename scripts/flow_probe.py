#!/usr/bin/env python3
"""可行性探针:测 Massive 网关的期权 trades/quotes 端点能否用于成交方向分类。

流程:取 AMD 现价 → 期权链快照挑一个近 ATM、≤14 天、当日成交量最大的合约
→ 拉它当天的 trades,报告:能否访问、总笔数(是否分页)、单次响应规模、
以及用 tick rule 粗分类的买/卖占比。用于判断"流量分类 GEX"覆盖多少合约、多久跑一次。
"""
import os
import time
from datetime import date, timedelta

import requests

KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
H = {"Authorization": f"Bearer {KEY}"}
SYM = "AMD"


def get(path, **params):
    params.setdefault("apiKey", KEY)
    url = path if path.startswith("http") else f"{BASE}{path}"
    r = requests.get(url, params=params, headers=H, timeout=40)
    return r


def main():
    today = date.today()
    # 现价
    q = get(f"/v2/aggs/ticker/{SYM}/prev").json()
    spot = (q.get("results") or [{}])[0].get("c")
    print(f"AMD prev close ≈ {spot}")

    # 期权链快照:挑 ±15%、≤14 天、当日量最大的合约
    lo, hi = spot * 0.85, spot * 1.15
    best = None
    url = f"/v3/snapshot/options/{SYM}?limit=250&strike_price.gte={lo:.2f}&strike_price.lte={hi:.2f}" \
          f"&expiration_date.gte={today}&expiration_date.lte={today + timedelta(days=14)}"
    n = 0
    while url:
        d = get(url).json()
        for o in d.get("results") or []:
            n += 1
            det, day = o.get("details") or {}, o.get("day") or {}
            vol = day.get("volume") or 0
            if best is None or vol > best[1]:
                best = (det.get("ticker"), vol, det.get("expiration_date"), det.get("strike_price"))
        url = d.get("next_url")
        if url:
            url = f"{BASE}{url.split('massive.com')[-1] if 'massive.com' in url else url.split('/', 3)[-1]}"
            url = url if url.startswith("http") else f"{BASE}/{url.lstrip('/')}"
    print(f"±15%/≤14天 合约数: {n};当日量最大: {best}")
    if not best or not best[0]:
        print("没找到合约,停")
        return

    contract = best[0]
    # 拉当天 trades(先要一页,看规模与分页)
    t0 = time.time()
    r = get(f"/v3/trades/{contract}", limit=50000)
    dt = time.time() - t0
    print(f"trades 状态码: {r.status_code}, 用时 {dt:.1f}s")
    if r.status_code != 200:
        print(f"trades 不可用: {r.text[:200]}")
        return
    body = r.json()
    trades = body.get("results") or []
    print(f"单次返回 {len(trades)} 笔, 是否还有下一页: {bool(body.get('next_url'))}")
    if trades:
        keys = list(trades[0].keys())
        print(f"trade 字段: {keys}")
        # tick rule 粗分类
        buys = sells = flat = 0
        prev = None
        for tr in trades:
            p = tr.get("price")
            if prev is None or p == prev:
                flat += 1
            elif p > prev:
                buys += 1
            else:
                sells += 1
            prev = p
        print(f"tick rule: 买 {buys} / 卖 {sells} / 平 {flat}")


if __name__ == "__main__":
    main()
