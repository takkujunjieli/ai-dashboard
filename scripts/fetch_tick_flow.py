#!/usr/bin/env python3
"""散户订单流引擎(live, 逐日增量)。对 research 页选取(config/retail_syms.json)的每只票,拉当日股票逐笔+逐报价,
BJZZ 识别(场外 TRF + 次美分)→ Barber 中点签名 → 聚合成每票每天一个净买入数,丢弃原始 tick。

方法(见 research.html 的散户订单流页,及 BJZZ 2021 / Barber 2024):
  识别散户候选 = 场外(trf_id 存在)且价格带次美分零头 Z∈(0,0.4)∪(0.6,1)(排除整分/半分)。
  方向         = NBBO 中点(quote rule:price>ask→买, <bid→卖, 之间→tick rule),不用次美分定向(Barber 修正)。
  聚合         = MBUY/MSELL(签名 size),retail_vol=MBUY+MSELL,total_vol=当日全部有效成交,
                 netbuy=(MBUY-MSELL)/retail_vol,intensity=retail_vol/total_vol。

产物:data/retail_flow_raw.json,按 day→ticker 存聚合数;滚动保留 RF_WINDOW(默认 30)自然日。
只读市场数据、只写这一个小 JSON(不落原始 tick)。在有 MASSIVE_API_KEY 的环境跑(Actions)。

env:
  RF_DAY     目标日 YYYY-MM-DD(默认:最近一个已收盘工作日)
  RF_SYMS    逗号分隔覆盖标的(默认:tickers.json 的 deep 集)
  RF_WINDOW  滚动保留自然日(默认 30)
  RF_CAP     每票 trades/quotes 最多翻页数 ×50k(默认 400,护栏防失控)
  RF_SMALL   =1 只跑 deep 首票,verbose
"""
import bisect
import json
import os
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests

ROOT = Path(__file__).resolve().parent.parent
KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
HEADERS = {"Authorization": f"Bearer {KEY}"}
OUT = ROOT / "data" / "retail_flow_raw.json"

WINDOW = int(os.environ.get("RF_WINDOW", "30"))
CAP = int(os.environ.get("RF_CAP", "400"))
SMALL = os.environ.get("RF_SMALL", "").lower() in ("1", "true")
# 与实盘/回测口径一致:剔除的成交条件(odd-lot/衍生价/序外等)
BAD_CONDITIONS = {201, 202, 203, 204, 205, 206, 207, 208, 210, 227, 228, 229, 230,
                  232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244,
                  245, 246, 247, 248}
RTH_GTE_H, RTH_LTE_H = "13:30:00", "20:00:00"   # 常规时段 UTC(夏令时;含少量冬令误差,对日聚合无碍)


def rebase(u):
    if not u:
        return None
    p = urlparse(u)
    return f"{BASE}{p.path}" + (f"?{p.query}" if p.query else "")


def get(path):
    url = path if path.startswith("http") else f"{BASE}{path}"
    sep = "&" if "?" in url else "?"
    full = url + f"{sep}apiKey={KEY}"
    for attempt in range(5):                     # 429 退避(网关限流)
        r = requests.get(full, headers=HEADERS, timeout=120)
        if r.status_code == 429:
            time.sleep(3 * (attempt + 1))
            continue
        r.raise_for_status()
        return r.json()
    r.raise_for_status()


def stream(path, on_row, cap=CAP):
    """翻页流式处理:对每行调用 on_row,不整表保存(控内存)。返回翻页数。"""
    url, n = path, 0
    while url and n < cap:
        d = get(url)
        for row in (d.get("results") or []):
            on_row(row)
        url = rebase(d.get("next_url"))
        n += 1
    return n


def subpenny(price):
    """Z = 价格的次美分零头(美分的小数部分),∈[0,1)。"""
    return round(price * 100, 6) % 1


def day_close(sym, day):
    """当日日线收盘(算前瞻收益用);失败返回 None。"""
    try:
        rows = get(f"/v2/aggs/ticker/{sym}/range/1/day/{day}/{day}?adjusted=true").get("results") or []
        return rows[0].get("c") if rows else None
    except Exception:
        return None


def last_trading_day():
    """最近一个已收盘交易日:UTC ≥21 点(美股收盘后)算当天已完,否则回退;跳周末。"""
    now = datetime.now(timezone.utc)
    d = now.date() - (timedelta(days=1) if now.hour < 21 else timedelta(0))
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d.isoformat()


def weekdays_back(n):
    """最近 n 个工作日(升序;不含今天)。忽略节假日——空数据日自动跳过。"""
    out, d = [], date.today() - timedelta(days=1)
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return sorted(out)


def target_days():
    """RF_DAYS(逗号列表)优先;否则 RF_BACKFILL=N(最近 N 工作日);否则单日 RF_DAY/最近工作日。"""
    if os.environ.get("RF_DAYS", "").strip():
        return sorted(s.strip() for s in os.environ["RF_DAYS"].split(",") if s.strip())
    n = int(os.environ.get("RF_BACKFILL", "0"))
    if n > 0:
        return weekdays_back(n)
    return [os.environ.get("RF_DAY", "").strip() or last_trading_day()]


def fetch_quotes(sym, win):
    """→ 排序的 (qts[], qba[(bid,ask)]) + 翻页数。"""
    qts, qba = [], []
    def on_q(x):
        ts, b, a = x.get("sip_timestamp"), x.get("bid_price"), x.get("ask_price")
        if ts and b and a:
            qts.append(ts); qba.append((b, a))
    npq = stream(f"/v3/quotes/{sym}?limit=50000&order=asc&sort=timestamp{win}", on_q)
    if qts and any(qts[i] > qts[i + 1] for i in range(min(len(qts) - 1, 5000))):
        order = sorted(range(len(qts)), key=lambda i: qts[i])
        qts = [qts[i] for i in order]; qba = [qba[i] for i in order]
    return qts, qba, npq


def fetch_trades(sym, win):
    """→ 精简逐笔 [(ts, price, size, off_retail_flag)] + total_vol + 场外笔占比 + 翻页数。
    只保留识别为散户候选(场外次美分)的笔用于签名;total_vol 统计全部有效成交。"""
    rows, tot = [], [0, 0, 0]   # total_vol, n_trades, n_off
    def on_t(t):
        ts, price = t.get("sip_timestamp"), t.get("price")
        size, conds = t.get("size") or 0, t.get("conditions") or []
        if ts is None or price is None or not size or any(c in BAD_CONDITIONS for c in conds):
            return
        tot[0] += size; tot[1] += 1
        off = t.get("trf_id") is not None
        if off:
            tot[2] += 1
        z = subpenny(price)
        if off and (0 < z < 0.4 or 0.6 < z < 1.0):        # BJZZ 识别:场外次美分
            rows.append((ts, price, size))
    npt = stream(f"/v3/trades/{sym}?limit=50000&order=asc&sort=timestamp{win}", on_t)
    return rows, tot, npt


def flow_for(sym, day, verbose=False):
    """返回该票当日聚合 dict,或 None(数据不足)。
    弱 HTTP 网关:trades/quotes/px 串行拉——并发会把网关压垮(实测 9 并发全 Read timeout)。"""
    win = f"&timestamp.gte={day}T{RTH_GTE_H}Z&timestamp.lte={day}T{RTH_LTE_H}Z"
    qts, qba, npq = fetch_quotes(sym, win)
    rtrades, tot, npt = fetch_trades(sym, win)
    px = day_close(sym, day)
    total_vol, n_trades, n_off = tot
    # 中点签名(Barber):对散户候选逐笔按 prevailing NBBO 定向,价内落回 tick rule
    mbuy = msell = 0
    prev = None
    for ts, price, size in rtrades:
        side = 0
        if qts:
            i = bisect.bisect_right(qts, ts) - 1
            if i >= 0:
                bid, ask = qba[i]
                side = 1 if price >= ask else -1 if price <= bid else 0
        if side == 0:
            side = 1 if (prev is not None and price > prev) else -1 if (prev is not None and price < prev) else 0
        prev = price
        if side > 0:
            mbuy += size
        elif side < 0:
            msell += size
    rv = mbuy + msell
    if n_trades == 0 or rv == 0:
        if verbose:
            print(f"  {sym} {day}: 数据不足 (trades={n_trades}, retail_vol={rv}, q页={npq} t页={npt})")
        return None
    out = {
        "mbuy": mbuy, "msell": msell,
        "netbuy": round((mbuy - msell) / rv, 6),
        "retail_vol": rv, "total_vol": total_vol,
        "intensity": round(rv / total_vol, 6) if total_vol else None,
        "px": px,
    }
    if verbose:
        print(f"  {sym} {day}: netbuy={out['netbuy']:+.3f} intensity={out['intensity']:.3f} px={px} "
              f"| 场外占比 {n_off/n_trades:.0%} 散户笔 {len(rtrades)} "
              f"| 翻页 q={npq} t={npt} | retail_vol={rv:,} total_vol={total_vol:,}")
    return out


def load_retail_syms():
    """散户流跑哪些票:config/retail_syms.json 的 symbols(由 research 页下拉编辑)。"""
    p = ROOT / "config" / "retail_syms.json"
    if p.exists():
        try:
            return [s.strip().upper() for s in json.loads(p.read_text()).get("symbols", []) if s.strip()]
        except Exception:
            pass
    return []


def load_store():
    if OUT.exists():
        try:
            return json.loads(OUT.read_text())
        except Exception:
            pass
    return {"updated": None, "window_days": WINDOW, "days": {}}


def evict(store):
    cutoff = (date.today() - timedelta(days=WINDOW)).isoformat()
    for d in [d for d in store["days"] if d < cutoff]:
        del store["days"][d]


def write_store(store):
    store["window_days"] = WINDOW
    store["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    evict(store)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(store, ensure_ascii=False, separators=(",", ":")))


def main():
    days = target_days()
    syms = ([s.strip().upper() for s in os.environ.get("RF_SYMS", "").split(",") if s.strip()]
            or load_retail_syms() or ["HOOD", "COIN", "RKLB"])   # 空=读 retail_syms.json(独立于 D/Q)
    if SMALL:
        syms = syms[:1]
    maxn = int(os.environ.get("RF_MAX", "8"))     # 护栏:防 deep=32 时误跑全量
    if len(syms) > maxn:
        print(f"⚠️ 标的 {len(syms)} 超 RF_MAX={maxn},只跑前 {maxn}(deep 请用 D/Q 剪到想跑的几只)")
        syms = syms[:maxn]
    print(f"BASE={BASE} days={days[0]}…{days[-1]}({len(days)}) 标的={len(syms)}只 {syms} "
          f"key={'set' if KEY else 'MISSING'} window={WINDOW}d cap={CAP}")

    store = load_store()
    t0 = time.time()
    for day in days:                              # 逐日;每日写盘(即使后续超时也保住已完成)
        dayrec = store["days"].get(day, {})
        ok = 0
        for s in syms:                            # 串行:弱网关扛不住并发
            if s in dayrec and os.environ.get("RF_FORCE", "").lower() not in ("1", "true"):
                ok += 1; continue                 # 断点续跑:已采集的 (day,票) 跳过
            try:
                r = flow_for(s, day, verbose=True)
                if r:
                    dayrec[s] = r; ok += 1
            except Exception as exc:
                print(f"  ✗ {s} {day}: {exc}")
        store["days"][day] = dayrec
        write_store(store)
        print(f"  [{day}] {ok}/{len(syms)} 写入 · 累计 {len(store['days'])} 天 · 用时 {(time.time()-t0)/60:.0f}min")
    print(f"\n完成 {len(days)} 天 · 存 {len(store['days'])} 天 → {OUT.relative_to(ROOT)} "
          f"({OUT.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
