#!/usr/bin/env python3
"""预注册回测:净签名期权流的 gamma-区制预测力。见 docs/backtest-flow-gamma-pilot.md。
历史重建 trades+quotes → Lee-Ready 净流 → 30min 网格 → 条件自相关交互检验(两版延迟 + 分层对照)。
自包含(不 import 实盘代码,口径冻结)、只读。在有 MASSIVE_API_KEY 环境跑(Actions)。

env:
  BT_DAYS   逗号分隔 YYYY-MM-DD(默认:最近 5 个工作日)
  BT_SYMS   逗号分隔(默认:config/tickers.json 的 watchlist 去 ETF)
  BT_TOPN   每票每天取近 ATM 合约数(默认 40)
  BT_SMALL  =1 只跑首票首日,verbose,验证管道
"""
import bisect
import json
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

import requests

ROOT = Path(__file__).resolve().parent.parent
KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
HEADERS = {"Authorization": f"Bearer {KEY}"}

STRIKE_BAND = 0.15
MAX_DTE = 14
TOPN = int(os.environ.get("BT_TOPN", "40"))
GRID_MIN = 30           # r_past / r_fwd 窗口
DELAY_MIN = 15          # 可交易版:期权数据实盘延迟
ETF_SKIP = {"SPY", "QQQ", "SOXX", "IWM", "DIA", "IVV", "VOO", "SMH", "XLK"}
BAD_CONDITIONS = {201, 202, 203, 204, 205, 206, 207, 208, 210, 227, 228, 229, 230,
                  232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244,
                  245, 246, 247, 248}
WORKERS = int(os.environ.get("BT_WORKERS", "4"))          # 组合内:每合约并发(×OUTER 不宜 >~16,否则网关 429)
OUTER_WORKERS = int(os.environ.get("BT_OUTER", "4"))       # 组合间:(票×天) 并发
GAMMA_W = os.environ.get("BT_GAMMA", "").lower() in ("1", "true")  # 诊断:按 BS 近似 gamma 加权
SIGMA = float(os.environ.get("BT_SIGMA", "0.6"))          # 无历史 IV,gamma 用假设 σ(形状对 σ 不敏感)


def bs_gamma(S, K, T, sigma):
    """BS gamma(r=0):φ(d1)/(S·σ·√T)。用于诊断'裸流反向是否因丢了 gamma 权重'。"""
    if S <= 0 or K <= 0 or T <= 0 or sigma <= 0:
        return 0.0
    d1 = (math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * math.sqrt(T))
    return math.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi) / (S * sigma * math.sqrt(T))
# pilot 窗口为夏令时(EDT=UTC-4):RTH 9:30-16:00 ET = 13:30-20:00 UTC
RTH_OPEN_UTC_H, RTH_CLOSE_UTC_H = 13.5, 20.0


def rebase(u):
    if not u:
        return None
    p = urlparse(u)
    return f"{BASE}{p.path}" + (f"?{p.query}" if p.query else "")


def get(path):
    url = path if path.startswith("http") else f"{BASE}{path}"
    sep = "&" if "?" in url else "?"
    full = url + f"{sep}apiKey={KEY}"
    r = None
    for attempt in range(5):                 # 429 退避重试(网关并发限流)
        r = requests.get(full, headers=HEADERS, timeout=45)
        if r.status_code == 429:
            time.sleep(3 * (attempt + 1))
            continue
        r.raise_for_status()
        return r.json()
    r.raise_for_status()


def paged(path, cap=6):
    out, url, n = [], path, 0
    while url and n < cap:
        d = get(url)
        out += d.get("results") or []
        url = rebase(d.get("next_url"))
        n += 1
    return out


def ns(day_str, hour_float):
    """某天 UTC 小时 → 纳秒 epoch。"""
    d = datetime.fromisoformat(day_str + "T00:00:00+00:00")
    return int((d.timestamp() + hour_float * 3600) * 1e9)


# ---------- 数据抓取 ----------

def underlying_series(sym, day):
    """当天 5min 收盘序列 [(ms, close)],升序。"""
    rows = paged(f"/v2/aggs/ticker/{sym}/range/5/minute/{day}/{day}?adjusted=true&sort=asc&limit=50000")
    return [(r["t"], r["c"]) for r in rows]


def day_vwap(sym, day):
    rows = get(f"/v2/aggs/ticker/{sym}/range/1/day/{day}/{day}").get("results") or []
    return rows[0].get("vw") or rows[0].get("c") if rows else None


def list_contracts(sym, day, spot):
    """as_of=day 列出近价 ≤14DTE 合约,取最近 ATM 的 TOPN 张。"""
    lo, hi = round(spot * (1 - STRIKE_BAND), 2), round(spot * (1 + STRIKE_BAND), 2)
    exp_lo, exp_hi = day, (date.fromisoformat(day) + timedelta(days=MAX_DTE)).isoformat()
    path = (f"/v3/reference/options/contracts?underlying_ticker={sym}&as_of={day}"
            f"&expiration_date.gte={exp_lo}&expiration_date.lte={exp_hi}"
            f"&strike_price.gte={lo}&strike_price.lte={hi}&limit=1000")
    rows = paged(path)
    cs = [{"ticker": r.get("ticker"), "strike": r.get("strike_price"),
           "type": r.get("contract_type"), "exp": r.get("expiration_date")}
          for r in rows if r.get("ticker") and r.get("strike_price")]
    cs.sort(key=lambda c: abs(c["strike"] - spot))   # 近 ATM 优先(活跃度代理)
    return cs[:TOPN]


def signed_trades(ticker, day):
    """Lee-Ready:返回 [(sip_ns, signed_size)],客户主动买 +size / 卖 −size。"""
    gte, lte = f"{day}T13:30:00Z", f"{day}T20:00:00Z"
    tr = paged(f"/v3/trades/{ticker}?limit=50000&order=asc&sort=timestamp"
               f"&timestamp.gte={gte}&timestamp.lte={lte}")
    qt = paged(f"/v3/quotes/{ticker}?limit=50000&order=asc&sort=timestamp"
               f"&timestamp.gte={gte}&timestamp.lte={lte}")
    q = sorted([(x.get("sip_timestamp"), x.get("bid_price"), x.get("ask_price"))
                for x in qt if x.get("sip_timestamp") and x.get("bid_price") and x.get("ask_price")])
    qts = [x[0] for x in q]
    out, prev, ld = [], None, 0
    for t in sorted(tr, key=lambda t: t.get("sip_timestamp") or 0):
        ts, price, size, conds = (t.get("sip_timestamp"), t.get("price"),
                                  t.get("size") or 0, t.get("conditions") or [])
        if ts is None or price is None or not size or any(c in BAD_CONDITIONS for c in conds):
            continue
        side = 0
        if qts:
            i = bisect.bisect_right(qts, ts) - 1
            if i >= 0:
                _, bid, ask = q[i]
                side = 1 if price >= ask else -1 if price <= bid else 0
        if side == 0:
            side = 1 if (prev is not None and price > prev) else -1 if (prev is not None and price < prev) else ld
        prev = price
        ld = side or ld
        out.append((ts, side * size))
    return out


# ---------- 单票单日重建 ----------

def reconstruct(sym, day, verbose=False):
    """返回该票当天的网格观测 [(T_iso, S_info, S_trade, r_past, r_fwd)]。r_fwd 未去均值。"""
    spot = day_vwap(sym, day)
    bars = underlying_series(sym, day)
    if not spot or len(bars) < 20:
        if verbose:
            print(f"  {sym} {day}: spot/bars 不足 (spot={spot}, bars={len(bars)})")
        return []
    contracts = list_contracts(sym, day, spot)
    if verbose:
        print(f"  {sym} {day}: spot≈{spot:.2f}, 近价≤14DTE 合约取 {len(contracts)} 张")
    # 并发抓每合约签名成交,合并(可选按 BS 近似 gamma 加权 → 诊断病因)
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        results = list(ex.map(lambda c: signed_trades(c["ticker"], day), contracts))
    flows = []
    for c, r in zip(contracts, results):
        if GAMMA_W:
            T = max((date.fromisoformat(c["exp"]) - date.fromisoformat(day)).days, 0.5) / 365
            w = bs_gamma(spot, c["strike"], T, SIGMA)
        else:
            w = 1.0
        for ts, sz in r:
            flows.append((ts, sz * w))
    flows.sort()
    fts = [f[0] for f in flows]
    fcum = []
    s = 0.0
    for _, sz in flows:
        s += sz
        fcum.append(s)
    if verbose:
        print(f"  {sym} {day}: 合并成交 {len(flows)} 笔, 全日净流 {s:+.0f}")

    bts = [b[0] for b in bars]

    def price_at(ms):
        i = bisect.bisect_right(bts, ms) - 1
        return bars[i][1] if i >= 0 else None

    def net_up_to(ns_ts):
        i = bisect.bisect_right(fts, ns_ts) - 1
        return fcum[i] if i >= 0 else 0.0

    obs = []
    g = GRID_MIN / 60.0
    t = RTH_OPEN_UTC_H + g          # 需要 T-30 与 T+30 都落在 RTH 内
    while t <= RTH_CLOSE_UTC_H - g + 1e-9:
        T_ms = int((datetime.fromisoformat(day + "T00:00:00+00:00").timestamp() + t * 3600) * 1000)
        T_ns = T_ms * 1_000_000
        p0, pm, pp = price_at(T_ms - GRID_MIN * 60000), price_at(T_ms), price_at(T_ms + GRID_MIN * 60000)
        if p0 and pm and pp and p0 > 0 and pm > 0:
            r_past = math.log(pm / p0)
            r_fwd = math.log(pp / pm)
            net_info = net_up_to(T_ns)
            net_trade = net_up_to(T_ns - DELAY_MIN * 60 * 1_000_000_000)  # 滞后 15min
            S_info = (net_info > 0) - (net_info < 0)
            S_trade = (net_trade > 0) - (net_trade < 0)
            obs.append((f"{day}T{int(t):02d}:{int((t%1)*60):02d}", S_info, S_trade, r_past, r_fwd))
        t += g
    return obs


# ---------- 统计 ----------

def pearson(xs, ys):
    n = len(xs)
    if n < 5:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    return sxy / math.sqrt(sxx * syy) if sxx > 0 and syy > 0 else None


def report(rows, version_idx, label):
    """rows: [(T_iso, S_info, S_trade, r_past, r_fwd_star, sym, day)]。version_idx: 1=info,2=trade。"""
    r_past = [r[3] for r in rows]
    r_fwd = [r[4] for r in rows]
    S = [r[version_idx] for r in rows]
    base = pearson(r_past, r_fwd)
    up = [(rp, rf) for s, rp, rf in zip(S, r_past, r_fwd) if s > 0]
    dn = [(rp, rf) for s, rp, rf in zip(S, r_past, r_fwd) if s < 0]
    c_up = pearson([x[0] for x in up], [x[1] for x in up]) if len(up) >= 5 else None
    c_dn = pearson([x[0] for x in dn], [x[1] for x in dn]) if len(dn) >= 5 else None
    inter = pearson([s * rp for s, rp in zip(S, r_past)], r_fwd)
    print(f"\n【{label}】样本 {len(rows)}(空γ {len(up)} / 多γ {len(dn)})")
    print(f"  无条件自相关 corr(r_past, r_fwd) = {fmt(base)}")
    print(f"  空γ组 corr₊ = {fmt(c_up)}   多γ组 corr₋ = {fmt(c_dn)}")
    diff = (c_up - c_dn) if (c_up is not None and c_dn is not None) else None
    print(f"  判定量 corr₊−corr₋ = {fmt(diff)}   (预注册:>0 且 ≥0.05 为'值得继续')")
    print(f"  交互 corr(S·r_past, r_fwd) = {fmt(inter)}   (β 符号代理,预注册:>0)")
    # 逐日方向一致性
    days = sorted(set(r[6] for r in rows))
    consistent = 0
    for d in days:
        dr = [r for r in rows if r[6] == d]
        u = [(r[3], r[4]) for r in dr if r[version_idx] > 0]
        dnn = [(r[3], r[4]) for r in dr if r[version_idx] < 0]
        cu = pearson([x[0] for x in u], [x[1] for x in u]) if len(u) >= 5 else None
        cd = pearson([x[0] for x in dnn], [x[1] for x in dnn]) if len(dnn) >= 5 else None
        if cu is not None and cd is not None and cu - cd > 0:
            consistent += 1
    print(f"  逐日 corr₊−corr₋>0 的天数: {consistent}/{len(days)}  (预注册:≥4/5 视为方向一致)")


def fmt(x):
    return "n/a" if x is None else f"{x:+.3f}"


def main():
    small = os.environ.get("BT_SMALL", "").lower() in ("1", "true")
    cfg = json.loads((ROOT / "config" / "tickers.json").read_text())
    syms = [s for s in (os.environ.get("BT_SYMS", "").split(",") if os.environ.get("BT_SYMS")
                        else cfg.get("watchlist") or []) if s and s not in ETF_SKIP]
    if os.environ.get("BT_DAYS"):
        days = [d.strip() for d in os.environ["BT_DAYS"].split(",") if d.strip()]
    else:  # 最近 5 个工作日(粗略,不排节假日)
        days, d = [], date.today() - timedelta(days=1)
        while len(days) < 5:
            if d.weekday() < 5:
                days.append(d.isoformat())
            d -= timedelta(days=1)
        days = sorted(days)
    if small:
        syms, days = syms[:1], days[-1:]
    print(f"BASE={BASE} key={'set' if KEY else 'MISSING'}  SYMS={syms}  DAYS={days}  "
          f"TOPN={TOPN}  SMALL={small}  OUTER={OUTER_WORKERS}×INNER={WORKERS}  "
          f"WEIGHT={'BS-gamma(σ=' + str(SIGMA) + ')' if GAMMA_W else 'size(裸流)'}", flush=True)

    combos = [(day, sym) for day in days for sym in syms]

    def work(dsy):
        day, sym = dsy
        try:
            return [(*o, sym, day) for o in reconstruct(sym, day, verbose=small)]
        except Exception as exc:  # noqa: BLE001
            print(f"  ✗ {sym} {day}: {str(exc)[:120]}", flush=True)
            return []

    allobs, done = [], 0    # (T_iso, S_info, S_trade, r_past, r_fwd, sym, day)
    with ThreadPoolExecutor(max_workers=OUTER_WORKERS) as ex:
        for (day, sym), res in zip(combos, ex.map(work, combos)):
            allobs += res
            done += 1
            print(f"  [{done}/{len(combos)}] {sym} {day}: {len(res)} obs", flush=True)
    if not allobs:
        print("\n无观测,退出(检查 as_of 合约端点 / 数据可用性)"); return

    # 市场中性化:每 (day, T) 横截面对 r_fwd 去均值
    from collections import defaultdict
    groups = defaultdict(list)
    for i, o in enumerate(allobs):
        groups[(o[6], o[0])].append(i)
    r_fwd_star = list(range(len(allobs)))
    for idxs in groups.values():
        m = sum(allobs[i][4] for i in idxs) / len(idxs)
        for i in idxs:
            r_fwd_star[i] = allobs[i][4] - m
    rows = [(allobs[i][0], allobs[i][1], allobs[i][2], allobs[i][3], r_fwd_star[i], allobs[i][5], allobs[i][6])
            for i in range(len(allobs))]

    print(f"\n===== 总观测 {len(rows)} · 票 {len(set(r[5] for r in rows))} · 天 {len(set(r[6] for r in rows))} =====")
    if small:
        print("(BT_SMALL:仅验证管道,不做统计判定)")
        return
    report(rows, 1, "信息上界版(成交时刻)")
    report(rows, 2, f"可交易版(信号滞后 {DELAY_MIN}min)")
    print("\n注:功效受限(~5 日块),以上为 pilot 效应量/方向,非显著性结论。见协议第 8 节。")


if __name__ == "__main__":
    main()
