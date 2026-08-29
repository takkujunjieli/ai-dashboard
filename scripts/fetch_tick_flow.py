#!/usr/bin/env python3
"""散户订单流引擎(live, 逐日增量)。对 deep(D)集里的每只票,拉当日股票逐笔+逐报价,
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

from _cfg import load_tickers

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
        r = requests.get(full, headers=HEADERS, timeout=60)
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


def last_trading_day():
    d = date.today() - timedelta(days=1)
    while d.weekday() >= 5:                        # 六/日回退到周五
        d -= timedelta(days=1)
    return d.isoformat()


def flow_for(sym, day, verbose=False):
    """返回该票当日聚合 dict,或 None(数据不足)。"""
    win = f"&timestamp.gte={day}T{RTH_GTE_H}Z&timestamp.lte={day}T{RTH_LTE_H}Z"
    # 1) 逐报价 → 排序的 (ts, bid, ask),供中点 asof
    qts, qba = [], []
    def on_q(x):
        ts, b, a = x.get("sip_timestamp"), x.get("bid_price"), x.get("ask_price")
        if ts and b and a:
            qts.append(ts); qba.append((b, a))
    npq = stream(f"/v3/quotes/{sym}?limit=50000&order=asc&sort=timestamp{win}", on_q)
    # 报价流已是 asc;确保有序
    if qts and any(qts[i] > qts[i + 1] for i in range(min(len(qts) - 1, 5000))):
        order = sorted(range(len(qts)), key=lambda i: qts[i])
        qts = [qts[i] for i in order]; qba = [qba[i] for i in order]

    # 2) 逐笔 → 识别散户候选(场外+次美分)→ 中点签名 → 聚合
    agg = {"mbuy": 0, "msell": 0, "total_vol": 0, "n_off": 0, "n_retail": 0, "n_trades": 0}
    prev = [None]
    def on_t(t):
        ts, price = t.get("sip_timestamp"), t.get("price")
        size, conds = t.get("size") or 0, t.get("conditions") or []
        if ts is None or price is None or not size or any(c in BAD_CONDITIONS for c in conds):
            return
        agg["n_trades"] += 1
        agg["total_vol"] += size
        off = t.get("trf_id") is not None                     # 场外/TRF
        if off:
            agg["n_off"] += 1
        z = subpenny(price)
        retail = off and (0 < z < 0.4 or 0.6 < z < 1.0)       # BJZZ 识别(场外次美分)
        if not retail:
            prev[0] = price
            return
        agg["n_retail"] += 1
        side = 0
        if qts:                                                # Barber:中点/quote rule 定向
            i = bisect.bisect_right(qts, ts) - 1
            if i >= 0:
                bid, ask = qba[i]
                side = 1 if price >= ask else -1 if price <= bid else 0
        if side == 0:                                          # 落在价内 → tick rule 回退
            side = 1 if (prev[0] is not None and price > prev[0]) else -1 if (prev[0] is not None and price < prev[0]) else 0
        prev[0] = price
        if side > 0:
            agg["mbuy"] += size
        elif side < 0:
            agg["msell"] += size
    npt = stream(f"/v3/trades/{sym}?limit=50000&order=asc&sort=timestamp{win}", on_t)

    rv = agg["mbuy"] + agg["msell"]
    if agg["n_trades"] == 0 or rv == 0:
        if verbose:
            print(f"  {sym} {day}: 数据不足 (trades={agg['n_trades']}, retail_vol={rv}, "
                  f"quote页={npq}, trade页={npt})")
        return None
    out = {
        "mbuy": agg["mbuy"], "msell": agg["msell"],
        "netbuy": round((agg["mbuy"] - agg["msell"]) / rv, 6),
        "retail_vol": rv, "total_vol": agg["total_vol"],
        "intensity": round(rv / agg["total_vol"], 6) if agg["total_vol"] else None,
    }
    if verbose:
        offshare = agg["n_off"] / agg["n_trades"]
        print(f"  {sym} {day}: netbuy={out['netbuy']:+.3f} intensity={out['intensity']:.3f} "
              f"| 场外占比 {offshare:.0%} 散户笔 {agg['n_retail']} "
              f"| 翻页 q={npq} t={npt} | retail_vol={rv:,} total_vol={agg['total_vol']:,}")
    return out


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


def main():
    day = os.environ.get("RF_DAY", "").strip() or last_trading_day()
    _, deep = load_tickers()
    syms = [s.strip().upper() for s in os.environ.get("RF_SYMS", "").split(",") if s.strip()] or deep
    if SMALL:
        syms = syms[:1]
    print(f"BASE={BASE} day={day} 标的={len(syms)}只 {syms if len(syms)<=8 else syms[:8]+['…']} "
          f"key={'set' if KEY else 'MISSING'} window={WINDOW}d cap={CAP}")

    store = load_store()
    dayrec = store["days"].get(day, {})
    ok = 0
    for s in syms:
        try:
            r = flow_for(s, day, verbose=True)
            if r:
                dayrec[s] = r; ok += 1
        except Exception as exc:
            print(f"  ✗ {s} {day}: {exc}")
    store["days"][day] = dayrec
    store["window_days"] = WINDOW
    store["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    evict(store)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(store, ensure_ascii=False, separators=(",", ":")))
    print(f"\n{day}: {ok}/{len(syms)} 只写入 · 存 {len(store['days'])} 天 → {OUT.relative_to(ROOT)} "
          f"({OUT.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
