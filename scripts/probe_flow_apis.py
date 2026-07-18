#!/usr/bin/env python3
"""一次性探针:dump flow-GEX 相关 API 的原始返回,确认字段/分页/量级。
目的:看 /v3/snapshot/options 是否已带 last_quote(免费买卖盘)、/v3/quotes 是否可用、
逐笔与逐报价的密度(为 quote-rule / Lee-Ready 的实现与成本估算打底)。

在有 MASSIVE_API_KEY 的环境跑(GitHub Actions diag/probe workflow)。只读,不写任何文件。
"""
import json
import os
from urllib.parse import urlparse

import requests

KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
HEADERS = {"Authorization": f"Bearer {KEY}"}
SYM = os.environ.get("PROBE_SYM", "AMD").upper()


def rebase(url):
    """next_url 返回的是公网域名,分页要把 host 改回私有网关(同 fetch_research.rebase_url)。"""
    if not url:
        return None
    p = urlparse(url)
    return f"{BASE}{p.path}" + (f"?{p.query}" if p.query else "")


def get(path, **params):
    params.setdefault("apiKey", KEY)
    url = path if path.startswith("http") else f"{BASE}{path}"
    r = requests.get(url, params=params, headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()


def dump(label, obj, limit=4000):
    s = json.dumps(obj, indent=2, default=str, ensure_ascii=False)
    print(f"\n----- {label} -----")
    print(s[:limit] + (f"\n… (truncated, total {len(s)} chars)" if len(s) > limit else ""))


def section(t):
    print("\n" + "=" * 70 + f"\n### {t}\n" + "=" * 70)


def main():
    print(f"BASE={BASE}  SYM={SYM}  key={'set' if KEY else 'MISSING'}")

    # 1) 期权链快照:dump 一整张合约的所有字段(看有没有 last_quote / last_trade)
    section("1) /v3/snapshot/options/{SYM} — 一张合约的完整原始字段")
    contract_ticker = None
    try:
        snap = get(f"/v3/snapshot/options/{SYM}", limit=250, **{"strike_price.gte": 1, "order": "asc"})
        results = snap.get("results") or []
        print(f"top-level keys: {list(snap.keys())}  | results 数: {len(results)}")
        if results:
            dump("results[0]  (完整一张合约)", results[0], 6000)
            print("\n>>> 是否含 last_quote:", "last_quote" in results[0],
                  "| last_trade:", "last_trade" in results[0],
                  "| greeks:", "greeks" in results[0],
                  "| open_interest:", "open_interest" in results[0])
            # 挑当日成交量最大的一张,拿它的 OCC 代码去测 trades / quotes
            best = max(results, key=lambda o: (o.get("day") or {}).get("volume") or 0)
            contract_ticker = (best.get("details") or {}).get("ticker")
            print(f"\n最活跃合约: {contract_ticker}  "
                  f"vol={(best.get('day') or {}).get('volume')} "
                  f"strike={(best.get('details') or {}).get('strike_price')} "
                  f"exp={(best.get('details') or {}).get('expiration_date')}")
    except Exception as exc:
        print("✗ snapshot 失败:", exc)

    if not contract_ticker:
        print("\n拿不到合约代码,后续 trades/quotes 跳过"); return

    # 2) 逐笔成交:字段 + 分页 + 密度
    section(f"2) /v3/trades/{contract_ticker} — 逐笔成交")
    try:
        tr = get(f"/v3/trades/{contract_ticker}", limit=1000, order="asc", sort="timestamp")
        rows = tr.get("results") or []
        print(f"本页条数: {len(rows)}  | 有 next_url(还有更多): {bool(tr.get('next_url'))}")
        if rows:
            dump("trades[0]  (完整一笔)", rows[0])
            print("字段:", sorted(rows[0].keys()))
    except Exception as exc:
        print("✗ trades 失败:", exc)

    # 3) 逐报价 NBBO:这是 quote-rule 需要的,确认可用性 + 字段 + 密度
    section(f"3) /v3/quotes/{contract_ticker} — 逐条 NBBO(quote rule 关键)")
    try:
        q = get(f"/v3/quotes/{contract_ticker}", limit=1000, order="asc", sort="timestamp")
        rows = q.get("results") or []
        print(f"本页条数: {len(rows)}  | 有 next_url(还有更多): {bool(q.get('next_url'))}")
        if rows:
            dump("quotes[0]  (完整一条)", rows[0])
            print("字段:", sorted(rows[0].keys()))
    except Exception as exc:
        print("✗ quotes 失败(可能套餐不含 quotes):", exc)

    # 4) 密度 + 全天量外推(修好 rebase 分页;翻至多 40 页,并按时间跨度外推整日)
    PAGES = 40
    section(f"4) 密度 + 全天外推(trades vs quotes,各翻至多 {PAGES} 页 ×1000)")
    for name, path in [("trades", f"/v3/trades/{contract_ticker}"),
                       ("quotes", f"/v3/quotes/{contract_ticker}")]:
        try:
            total, pages = 0, 0
            first_ts = last_ts = None
            d = get(path, limit=1000, order="asc", sort="timestamp")
            while True:
                rows = d.get("results") or []
                total += len(rows); pages += 1
                for r in rows:
                    ts = r.get("sip_timestamp")
                    if ts:
                        first_ts = ts if first_ts is None else first_ts
                        last_ts = ts
                nxt = rebase(d.get("next_url"))
                if not nxt or pages >= PAGES:
                    break
                d = get(nxt)
            span_min = (last_ts - first_ts) / 1e9 / 60 if (first_ts and last_ts) else 0
            rate = total / span_min if span_min else 0
            full_day = rate * 390  # RTH 6.5h = 390 分钟
            print(f"  {name}: 抓到 {total} 条 / {pages} 页{' (仍有更多)' if nxt else ' (已到底)'}"
                  f"  | 覆盖 {span_min:.1f} 分钟  | ≈{rate:.0f} 条/分钟  | 整日外推 ≈{full_day:,.0f} 条")
        except Exception as exc:
            print(f"  {name}: 失败 {exc}")


if __name__ == "__main__":
    main()
