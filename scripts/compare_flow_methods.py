#!/usr/bin/env python3
"""周末验证:对指定交易日,逐合约比较 tick rule vs Lee-Ready(逐笔+NBBO)的流量判向。
证明 (a) delta 污染是否真实(趋势日两法分歧多不多、是否偏向标的方向),
(b) 精确层是否改变 flow-GEX 的净方向/符号。只读,在有 MASSIVE_API_KEY 环境跑。

env: CMP_SYM(默认 MU) · CMP_DAY(默认 2026-07-17,须为交易日)
"""
import bisect
import os
from datetime import date
from urllib.parse import urlparse

import requests

KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
HEADERS = {"Authorization": f"Bearer {KEY}"}
SYM = os.environ.get("CMP_SYM", "MU").upper()
DAY = os.environ.get("CMP_DAY", "2026-07-17")
FLOW_TOPN = int(os.environ.get("FLOW_TOPN", "40"))
FLOW_STRIKE_BAND = 0.15
FLOW_MAX_DTE = 14
FLOW_BAD_CONDITIONS = {201, 202, 203, 204, 205, 206, 207, 208, 210, 227, 228, 229, 230,
                       232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244,
                       245, 246, 247, 248}


def rebase(url):
    if not url:
        return None
    p = urlparse(url)
    return f"{BASE}{p.path}" + (f"?{p.query}" if p.query else "")


def get(path, **params):
    params.setdefault("apiKey", KEY)
    url = path if path.startswith("http") else f"{BASE}{path}"
    r = requests.get(url, params=params, headers=HEADERS, timeout=40)
    r.raise_for_status()
    return r.json()


def paged(path, cap=4):
    out, url, pages = [], path, 0
    while url and pages < cap:
        d = get(url)
        out += d.get("results") or []
        url = rebase(d.get("next_url"))
        pages += 1
    return out


def fetch_trades(tk, gte, lte):
    rows = paged(f"/v3/trades/{tk}?limit=50000&order=asc&sort=timestamp"
                 f"&timestamp.gte={gte}&timestamp.lte={lte}")
    return [(t.get("sip_timestamp"), t.get("price"), t.get("size") or 0, t.get("conditions") or []) for t in rows]


def fetch_quotes(tk, gte, lte):
    rows = paged(f"/v3/quotes/{tk}?limit=50000&order=asc&sort=timestamp"
                 f"&timestamp.gte={gte}&timestamp.lte={lte}")
    return [(q.get("sip_timestamp"), q.get("bid_price"), q.get("ask_price")) for q in rows]


def classify_tick(trades):
    buy = sell = 0.0; prev = None; ld = 0
    for _ts, price, size, conds in sorted(trades, key=lambda t: t[0] or 0):
        if price is None or not size or any(c in FLOW_BAD_CONDITIONS for c in conds):
            continue
        if prev is None:
            prev = price; continue
        d = 1 if price > prev else -1 if price < prev else ld
        prev = price
        if d > 0:
            buy += size; ld = 1
        elif d < 0:
            sell += size; ld = -1
    return buy - sell


def classify_lee(trades, quotes):
    q = sorted([x for x in quotes if x[0] and x[1] and x[2]], key=lambda x: x[0])
    qts = [x[0] for x in q]
    buy = sell = 0.0; prev = None; ld = 0
    for ts, price, size, conds in sorted(trades, key=lambda t: t[0] or 0):
        if price is None or not size or any(c in FLOW_BAD_CONDITIONS for c in conds):
            continue
        side = 0
        if ts is not None and qts:
            i = bisect.bisect_right(qts, ts) - 1
            if i >= 0:
                _, bid, ask = q[i]
                if price >= ask:
                    side = 1
                elif price <= bid:
                    side = -1
        if side == 0:
            side = 1 if (prev is not None and price > prev) else -1 if (prev is not None and price < prev) else ld
        prev = price
        if side > 0:
            buy += size; ld = 1
        elif side < 0:
            sell += size; ld = -1
    return buy - sell


def main():
    print(f"SYM={SYM}  DAY={DAY}  key={'set' if KEY else 'MISSING'}  N={FLOW_TOPN}")
    # 当日标的涨跌(用于关联 delta 污染:tick rule 应系统性偏向当日方向)
    try:
        agg = get(f"/v2/aggs/ticker/{SYM}/range/1/day/{DAY}/{DAY}").get("results") or []
        if agg:
            o, c = agg[0]["o"], agg[0]["c"]
            print(f"标的当日: O{o} C{c}  涨跌 {(c/o-1)*100:+.1f}%")
    except Exception as exc:
        print("标的涨跌获取失败:", exc)

    snap = get(f"/v3/snapshot/options/{SYM}", limit=250, **{"strike_price.gte": 1, "order": "asc"})
    results = snap.get("results") or []
    spot = ((results[0] if results else {}).get("underlying_asset") or {}).get("price")
    print(f"snapshot 合约数 {len(results)}  spot≈{spot}")
    if not spot:
        print("无 spot,退出"); return

    lo, hi = spot * (1 - FLOW_STRIKE_BAND), spot * (1 + FLOW_STRIKE_BAND)
    today = date.today()
    cand = []
    for o in results:
        det = o.get("details") or {}
        k = det.get("strike_price"); exp = det.get("expiration_date")
        if not (k and exp and lo <= k <= hi):
            continue
        try:
            dte = (date.fromisoformat(exp) - today).days
        except Exception:
            continue
        if not 0 <= dte <= FLOW_MAX_DTE:
            continue
        gamma = (o.get("greeks") or {}).get("gamma") or 0
        oi = o.get("open_interest") or 0
        w = abs(gamma * oi * spot * spot * 0.01)  # gamma 名义权重(现值近似)
        cand.append((det.get("ticker"), k, det.get("contract_type"), w))
    ranked = sorted(cand, key=lambda x: -x[3])[:FLOW_TOPN]
    print(f"flow band 候选 {len(cand)},取 gamma 权重 top-{len(ranked)}\n")

    gte, lte = f"{DAY}T13:30:00Z", f"{DAY}T20:00:00Z"  # EDT 9:30-16:00
    agree = disagree = both_zero = 0
    tick_dir_sum = lee_dir_sum = 0.0   # 客户净方向 × gamma权重(>0=净买)
    rows = []
    for tk, k, typ, w in ranked:
        try:
            tr = fetch_trades(tk, gte, lte)
            qt = fetch_quotes(tk, gte, lte)
        except Exception as exc:
            print(f"  {tk}: 抓取失败 {exc}"); continue
        nt = classify_tick(tr)
        nl = classify_lee(tr, qt)
        st = (nt > 0) - (nt < 0)
        sl = (nl > 0) - (nl < 0)
        tick_dir_sum += st * w
        lee_dir_sum += sl * w
        if st == 0 and sl == 0:
            both_zero += 1
        elif st == sl:
            agree += 1
        else:
            disagree += 1
        rows.append((k, typ, len(tr), len(qt), nt, nl, "≠" if st != sl else ""))

    print(f"{'strike':>8}{'type':>5}{'#tr':>6}{'#qt':>7}{'tick_net':>10}{'lee_net':>10}  分歧")
    for k, typ, ntr, nqt, nt, nl, flag in rows:
        print(f"{k:>8}{typ:>5}{ntr:>6}{nqt:>7}{nt:>10.0f}{nl:>10.0f}  {flag}")

    n = len(rows)
    print(f"\n=== 汇总(top-{n})===")
    print(f"方向一致 {agree} · 分歧 {disagree} · 两法都判0 {both_zero}"
          f"  → 分歧率 {disagree/max(agree+disagree,1)*100:.0f}%")
    # dealer 符号净方向:客户净买(dir_sum>0)→ dealer 净空 → 空 gamma
    print(f"gamma 加权客户净方向:  tick rule {tick_dir_sum:+,.0f}   Lee-Ready {lee_dir_sum:+,.0f}")
    dt = (tick_dir_sum > 0) - (tick_dir_sum < 0)
    dl = (lee_dir_sum > 0) - (lee_dir_sum < 0)
    print(f"净方向符号:  tick={'+买' if dt>0 else '-卖' if dt<0 else '0'}  "
          f"Lee={'+买' if dl>0 else '-卖' if dl<0 else '0'}  "
          f"{'→ 符号被翻转!' if dt != dl else '→ 符号一致'}")


if __name__ == "__main__":
    main()
