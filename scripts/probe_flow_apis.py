#!/usr/bin/env python3
"""一次性探针:dump flow-GEX 相关 API 的原始返回,确认字段/分页/量级。
目的:看 /v3/snapshot/options 是否已带 last_quote(免费买卖盘)、/v3/quotes 是否可用、
逐笔与逐报价的密度(为 quote-rule / Lee-Ready 的实现与成本估算打底)。

在有 MASSIVE_API_KEY 的环境跑(GitHub Actions diag/probe workflow)。只读,不写任何文件。
"""
import json
import os

import requests

KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
HEADERS = {"Authorization": f"Bearer {KEY}"}
SYM = os.environ.get("PROBE_SYM", "AMD").upper()


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


def probe_equity(sym):
    """股票逐笔/逐报价探针:确认 (a) 权限, (b) exchange 字段(隔离场外 TRF),
    (c) 次美分价格精度, (d) 密度(为成本估算)。这是 retail-flow 引擎的前置门槛。"""
    from collections import Counter
    from datetime import datetime, timezone
    rw = lambda u: u.replace("https://api.massive.com", BASE) if u else u   # next_url 指向官方 host,重写到网关
    ts2d = lambda ns: datetime.fromtimestamp(ns / 1e9, timezone.utc).strftime("%Y-%m-%d %H:%M") if ns else "?"
    section(f"0) 股票 /v3/trades/{sym} — 逐笔(exchange + 次美分 + 密度);order=desc 取最新")
    try:
        tr = get(f"/v3/trades/{sym}", limit=1000, order="desc", sort="timestamp")
    except Exception as exc:
        print(f"✗ 股票逐笔失败(权限/套餐?): {exc}")
        print("   → 若为 403/entitlement,股票 tick 引擎不可行,需走 fallback(期权流复用 / FINRA)")
        return
    rows = tr.get("results") or []
    print(f"本页条数: {len(rows)}  | 有 next_url: {bool(tr.get('next_url'))}")
    if not rows:
        print("   → 返回空(可能延迟套餐/非交易时段);换个交易日或用带日期的 range 再试"); return
    dump("equity trades[0]  (完整一笔)", rows[0])
    print("字段:", sorted(rows[0].keys()))
    print(f">>> 数据时点(本页首/末 sip): {ts2d(rows[0].get('sip_timestamp'))} … {ts2d(rows[-1].get('sip_timestamp'))} UTC")
    # (b) exchange 分布 + TRF/场外标记
    exch = Counter(r.get("exchange") for r in rows)
    n_trf = sum(1 for r in rows if r.get("trf_id") is not None)
    print(f"\n>>> exchange 码分布(本页): {dict(exch)}")
    print(f">>> 含 trf_id(场外/TRF 标记)的笔数: {n_trf}/{len(rows)}  "
          f"({100*n_trf/len(rows):.0f}%)  | 有 trf_timestamp 字段: {'trf_timestamp' in rows[0]}")
    # (c) 次美分精度:Z=(100*price) 的小数部分,>0 说明保留了次美分
    def subpenny(p):
        z = (round(p * 100, 6)) % 1
        return z
    zs = [subpenny(r["price"]) for r in rows if r.get("price") is not None]
    n_sub = sum(1 for z in zs if 1e-6 < z < 1 - 1e-6)
    print(f">>> 次美分精度: {n_sub}/{len(zs)} 笔价格带次美分零头({100*n_sub/max(len(zs),1):.0f}%)  "
          f"样例价格: {[round(r['price'],4) for r in rows[:6] if r.get('price') is not None]}")
    # (d) 密度:翻几页估当日总量级 → 成本
    total, nxt, pages = len(rows), rw(tr.get("next_url")), 1
    while nxt and pages < 5:
        try:
            d = get(nxt); total += len(d.get("results") or []); nxt = rw(d.get("next_url")); pages += 1
        except Exception as exc:
            print(f"   翻页失败: {exc}"); break
    print(f">>> 密度: ≥{total} 笔(翻 {pages} 页{',仍有更多→当日海量' if nxt else ',已到底'})  "
          f"每 50k/请求 → 约需 {max(1, total)//50000 + 1}+ 请求/票/天(下限)")
    # 逐报价 NBBO(中点签名需要)
    section(f"0b) 股票 /v3/quotes/{sym} — 逐条 NBBO(中点签名关键)")
    try:
        q = get(f"/v3/quotes/{sym}", limit=1000, order="desc", sort="timestamp")
        qr = q.get("results") or []
        print(f"本页条数: {len(qr)}  | 有 next_url: {bool(q.get('next_url'))}")
        if qr:
            dump("equity quotes[0]  (完整一条)", qr[0])
            print("字段:", sorted(qr[0].keys()),
                  "| 有 bid/ask:", all(k in qr[0] for k in ("bid_price", "ask_price")))
    except Exception as exc:
        print(f"✗ 股票逐报价失败(中点签名不可得则退回 tick-rule): {exc}")


def probe_concurrency(sym):
    """诊断:网关是'按连接限速'(并发能叠加)还是'总出口封顶'(并发无用)。
    同一票、不重叠时段各取一整页(50k),对比 1/2/3 路并发的聚合吞吐;并看是否 gzip。"""
    import time
    from concurrent.futures import ThreadPoolExecutor
    from datetime import date, timedelta
    section("5) 并发吞吐诊断(按连接限速 vs 总出口封顶)")
    day = date.today() - timedelta(days=1)
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    day = day.isoformat()
    slots = [("13:30:00", "15:30:00"), ("15:30:00", "17:30:00"), ("17:30:00", "19:30:00")]

    def fetch(slot):
        g, l = slot
        url = (f"{BASE}/v3/trades/{sym}?limit=50000&order=asc&sort=timestamp"
               f"&timestamp.gte={day}T{g}Z&timestamp.lte={day}T{l}Z&apiKey={KEY}")
        t0 = time.time()
        try:
            r = requests.get(url, headers=HEADERS, timeout=240)
            dt = time.time() - t0
            nb = len(r.content)
            rows = len(r.json().get("results") or []) if r.status_code == 200 else 0
            return nb, rows, dt, r.status_code, r.headers.get("content-encoding", "none")
        except Exception as exc:
            return 0, 0, time.time() - t0, f"ERR:{type(exc).__name__}", "?"

    print(f"票={sym} 日={day}(每路一整页 50k;不重叠时段避免缓存)")
    base_mbps = None
    for C in (1, 2, 3):
        use = slots[:C]
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=C) as ex:
            res = list(ex.map(fetch, use))
        wall = max(time.time() - t0, 1e-6)
        tot = sum(x[0] for x in res)
        rows = sum(x[1] for x in res)
        mbps = tot / 1e6 / wall
        if C == 1:
            base_mbps = mbps or 1e-9
        per = " ".join(f"{x[2]:.0f}s/{x[0]/1e6:.1f}MB/{x[3]}" for x in res)
        print(f"  并发{C}: wall {wall:5.0f}s · 总 {tot/1e6:5.1f}MB/{rows}行 · 聚合 {mbps:5.2f} MB/s "
              f"(×{mbps/base_mbps:.1f}) · gzip={res[0][4]} · 每路[{per}]")
    print("  判读:聚合 MB/s 随并发≈线性↑ → 按连接限速(并发有效);≈持平 → 总出口封顶(并发无用,得压数据/升网关)。"
          " gzip=none 则开压缩是质变。")


def main():
    print(f"BASE={BASE}  SYM={SYM}  key={'set' if KEY else 'MISSING'}")
    probe_equity(SYM)
    probe_concurrency(SYM)

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

    # 4) 密度对比:同一合约当日 trades vs quotes 大致条数(各多翻几页看量级)
    section("4) 密度粗估(trades vs quotes,各翻至多 5 页 ×1000)")
    for name, path in [("trades", f"/v3/trades/{contract_ticker}"),
                       ("quotes", f"/v3/quotes/{contract_ticker}")]:
        try:
            total, url, pages = 0, None, 0
            nxt = None
            first = get(path, limit=1000, order="asc", sort="timestamp")
            total += len(first.get("results") or []); nxt = first.get("next_url"); pages = 1
            while nxt and pages < 5:
                d = get(nxt)
                total += len(d.get("results") or []); nxt = d.get("next_url"); pages += 1
            print(f"  {name}: ≥{total} 条(翻了 {pages} 页{',仍有更多' if nxt else ',已到底'})")
        except Exception as exc:
            print(f"  {name}: 失败 {exc}")


if __name__ == "__main__":
    main()
