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
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests
from requests.adapters import HTTPAdapter

ROOT = Path(__file__).resolve().parent.parent
KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
HEADERS = {"Authorization": f"Bearer {KEY}"}
OUT = ROOT / "data" / "retail_flow_raw.json"

# 连接复用:keep-alive + 连接池,省掉每页重建 TCP 的冷启动开销(实测串行首请求被狠罚)
SESSION = requests.Session()
_adapter = HTTPAdapter(pool_connections=8, pool_maxsize=8)
SESSION.mount("http://", _adapter)
SESSION.mount("https://", _adapter)

WINDOW = int(os.environ.get("RF_WINDOW", "30"))
CAP = int(os.environ.get("RF_CAP", "120"))            # 单流最多翻页(×50k);120 页=6M 行,足够任何单名一天
TICKER_SEC = int(os.environ.get("RF_TICKER_SEC", "600"))  # 单票硬墙:超时跳过(防弱网关卡死整跑)
SAMPLE_SEC = int(os.environ.get("RF_SAMPLE_SEC", "1200"))  # 采样单票墙:几十个小请求,慢网关下给更宽
VAL_SEC = int(os.environ.get("RF_VAL_SEC", "1800"))       # 验证全量墙:一晚只跑一只,给足时间
SMALL = os.environ.get("RF_SMALL", "").lower() in ("1", "true")
# 采样模式(RF_SAMPLE=1):先读免费分钟量 → 挑高价值窗口 → 只下这些窗口的 trades+quotes,
# 用分层比率估计逼近全天散户净买入(见 research 页说明)。大幅降 IO,支持 28+ 只/夜。
SAMPLE = os.environ.get("RF_SAMPLE", "").lower() in ("1", "true")
EDGE_MIN = int(os.environ.get("RF_EDGE_MIN", "10"))   # 开/收各必采分钟(高量+散户重)
MID_BINS = int(os.environ.get("RF_MID_BINS", "15"))   # 中段分箱数,每箱取量最大 1 分钟 → 2min 块
BOOT = int(os.environ.get("RF_BOOT", "200"))          # 精确版块自助 CI 次数(0=不算)
VAL_WINDOW = int(os.environ.get("RF_VAL_WINDOW", "120"))  # 验证记录(全量vs采样)保留天数
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
        r = SESSION.get(full, headers=HEADERS, timeout=(15, 90))   # (连接, 每读块);无数据 90s 即断,防挂死
        if r.status_code == 429:
            time.sleep(3 * (attempt + 1))
            continue
        r.raise_for_status()
        return r.json()
    r.raise_for_status()


def stream(path, on_row, cap=CAP, deadline=None):
    """翻页流式处理:对每行调用 on_row,不整表保存(控内存)。返回翻页数。
    deadline(epoch 秒):超过则抛 TimeoutError → 上层跳过该票(防弱网关卡死整跑)。"""
    url, n = path, 0
    while url and n < cap:
        if deadline and time.time() > deadline:
            raise TimeoutError(f"per-ticker deadline({n}页)")
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


def fetch_quotes(sym, win, deadline=None):
    """→ 排序的 (qts[], qba[(bid,ask)]) + 翻页数。"""
    qts, qba = [], []
    def on_q(x):
        ts, b, a = x.get("sip_timestamp"), x.get("bid_price"), x.get("ask_price")
        if ts and b and a:
            qts.append(ts); qba.append((b, a))
    npq = stream(f"/v3/quotes/{sym}?limit=50000&order=asc&sort=timestamp{win}", on_q, deadline=deadline)
    if qts and any(qts[i] > qts[i + 1] for i in range(min(len(qts) - 1, 5000))):
        order = sorted(range(len(qts)), key=lambda i: qts[i])
        qts = [qts[i] for i in order]; qba = [qba[i] for i in order]
    return qts, qba, npq


def fetch_trades(sym, win, deadline=None):
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
    npt = stream(f"/v3/trades/{sym}?limit=50000&order=asc&sort=timestamp{win}", on_t, deadline=deadline)
    return rows, tot, npt


def flow_for(sym, day, verbose=False, ticker_sec=None):
    """返回该票当日聚合 dict,或 None(数据不足)。ticker_sec:单票硬墙秒(默认 TICKER_SEC;验证全量用更大)。
    每票内 trades ‖ quotes 两条独立流 2 并发拉(实测甜区:聚合吞吐 0.57→2.65 MB/s,~2×+;
    跨票仍串行,保证总并发 ≤2~3,不触网关上限——9 并发会全 Read timeout)。"""
    win = f"&timestamp.gte={day}T{RTH_GTE_H}Z&timestamp.lte={day}T{RTH_LTE_H}Z"
    dl = time.time() + (ticker_sec or TICKER_SEC)  # 单票硬墙:两条流都到点即抛,跳过该票不拖垮整跑
    with ThreadPoolExecutor(max_workers=2) as ex:
        fq = ex.submit(fetch_quotes, sym, win, dl)
        ft = ex.submit(fetch_trades, sym, win, dl)
        qts, qba, npq = fq.result()
        rtrades, tot, npt = ft.result()
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


def _rth_bounds(day):
    return (datetime.fromisoformat(f"{day}T{RTH_GTE_H}+00:00"),
            datetime.fromisoformat(f"{day}T{RTH_LTE_H}+00:00"))


def _fmt(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def minute_bars(sym, day):
    """当日 RTH 分钟量 {minute_dt: volume}(免费:一条 aggs 请求)。给窗口选择 + 分层真实总量。"""
    rows = get(f"/v2/aggs/ticker/{sym}/range/1/minute/{day}/{day}?adjusted=true&sort=asc&limit=50000").get("results") or []
    lo, hi = _rth_bounds(day)
    out = {}
    for r in rows:
        t = r.get("t")
        if t is None:
            continue
        dt = datetime.fromtimestamp(t / 1000, timezone.utc).replace(second=0, microsecond=0)
        if lo <= dt < hi:
            out[dt] = r.get("v") or 0
    return out


def select_windows(vmap, day):
    """据分钟量挑 ~EDGE*2 + MID_BINS*2 分钟 → 合并成连续块 [(gte_dt, lte_dt)]。
    开/收必采(高量+散户重);中段分箱、每箱取量最大 1 分钟 + 其后 1 分钟(既覆量又铺开)。"""
    lo, hi = _rth_bounds(day)
    mn = timedelta(minutes=1)
    chosen = set()
    m = lo
    while m < lo + EDGE_MIN * mn:
        chosen.add(m); m += mn
    m = hi - EDGE_MIN * mn
    while m < hi:
        chosen.add(m); m += mn
    mid_lo, mid_hi = lo + EDGE_MIN * mn, hi - EDGE_MIN * mn
    total_mid = int((mid_hi - mid_lo) / mn)
    if total_mid > 0 and MID_BINS > 0:
        binsz = max(1, total_mid // MID_BINS)
        b = mid_lo
        while b < mid_hi:
            be = min(b + binsz * mn, mid_hi)
            best, bv, mm = None, -1, b
            while mm < be:
                v = vmap.get(mm, 0)
                if v > bv:
                    bv, best = v, mm
                mm += mn
            if best is not None:
                chosen.add(best)
                if best + mn < mid_hi:
                    chosen.add(best + mn)
            b = be
    mins = sorted(chosen)
    if not mins:
        return []
    windows, s, e = [], mins[0], mins[0]
    for m in mins[1:]:
        if m == e + mn:
            e = m
        else:
            windows.append((s, e + mn)); s = e = m
    windows.append((s, e + mn))
    return windows


def flow_for_sampled(sym, day, deadline=None, verbose=False):
    """采样版:只下选中窗口的 trades+quotes,用免费分钟量做分层比率估计。
    返回 {netbuy(精确), intensity(精确), netbuy_naive, intensity_naive, ci, ...} 或 None。"""
    vmap = minute_bars(sym, day)
    if not vmap:
        if verbose:
            print(f"  {sym} {day}(采样): 无分钟量(休市?)")
        return None
    lo, hi = _rth_bounds(day)
    mn = timedelta(minutes=1)
    windows = select_windows(vmap, day)

    def strat(dt):
        if dt < lo + timedelta(minutes=30):
            return "open"
        if dt >= hi - timedelta(minutes=30):
            return "close"
        return "mid"

    win_agg = []                                   # 每窗口 {层: [rnet, rvol, sv]}(sv=该窗口真实分钟量)
    for g, l in windows:
        winq = f"&timestamp.gte={_fmt(g - timedelta(seconds=3))}&timestamp.lte={_fmt(l)}"  # 报价前探 3s 拿现行 NBBO
        wint = f"&timestamp.gte={_fmt(g)}&timestamp.lte={_fmt(l)}"
        qts, qba, _ = fetch_quotes(sym, winq, deadline)
        rtrades, _tot, _ = fetch_trades(sym, wint, deadline)
        local, prev = {}, None
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
            if side == 0:
                continue                            # 与全量口径一致:无向的不计
            dt = datetime.fromtimestamp(ts / 1e9, timezone.utc).replace(second=0, microsecond=0)
            b = local.setdefault(dt, [0, 0])
            b[0 if side > 0 else 1] += size
        agg, m = {}, g
        while m < l:
            a = agg.setdefault(strat(m), [0, 0, 0])
            buy, sell = local.get(m, (0, 0))
            a[0] += buy - sell; a[1] += buy + sell; a[2] += vmap.get(m, 0)
            m += mn
        win_agg.append(agg)

    V = {"open": 0, "mid": 0, "close": 0}          # 分层真实总量(全分钟,来自 bars)
    for dt, v in vmap.items():
        V[strat(dt)] += v
    Vtot = sum(V.values()) or 1

    def estimate(aggs):
        """分层比率估计:每层用采样比例×真实层量放大 → 精确 netbuy/intensity。"""
        S = {"open": [0, 0, 0], "mid": [0, 0, 0], "close": [0, 0, 0]}
        for agg in aggs:
            for h, (rn, rv, sv) in agg.items():
                S[h][0] += rn; S[h][1] += rv; S[h][2] += sv
        num = den = rtot = 0.0
        for h in S:
            rn, rv, sv = S[h]
            if sv <= 0 or rv <= 0:
                continue
            R = (rv / sv) * V[h]                    # 该层估计散户量 = 采样散户占比 × 真实层量
            num += (rn / rv) * R; den += R; rtot += R
        return (num / den if den else None), (rtot / Vtot)

    nb_p, it_p = estimate(win_agg)
    srn = sum(a[0] for agg in win_agg for a in agg.values())
    srv = sum(a[1] for agg in win_agg for a in agg.values())
    ssv = sum(a[2] for agg in win_agg for a in agg.values())
    if nb_p is None or srv == 0:
        if verbose:
            print(f"  {sym} {day}(采样): 数据不足(散户量=0)")
        return None
    nb_naive = srn / srv
    it_naive = srv / ssv if ssv else None
    ci = None
    if BOOT > 0 and len(win_agg) >= 3:
        import random
        boots, k = [], len(win_agg)
        for _ in range(BOOT):
            b, _ = estimate([win_agg[random.randrange(k)] for _ in range(k)])
            if b is not None:
                boots.append(b)
        if len(boots) >= 20:
            boots.sort()
            ci = [round(boots[int(0.025 * len(boots))], 4), round(boots[int(0.975 * len(boots))], 4)]
    out = {
        "netbuy": round(nb_p, 6), "intensity": round(it_p, 6),
        "netbuy_naive": round(nb_naive, 6), "intensity_naive": round(it_naive, 6) if it_naive is not None else None,
        "ci": ci, "px": day_close(sym, day),
        "sampled_min": sum(int((l - g) / mn) for g, l in windows), "method": "sample",
    }
    if verbose:
        print(f"  {sym} {day}(采样): netbuy_p={out['netbuy']:+.3f} naive={out['netbuy_naive']:+.3f} "
              f"ci={ci} inten_p={out['intensity']:.3f} | 窗口 {len(windows)} 段/{out['sampled_min']}min")
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
    val = store.get("validation")               # 验证记录保留更久(攒采样-全量对照)
    if val:
        vcut = (date.today() - timedelta(days=VAL_WINDOW)).isoformat()
        for d in [d for d in val if d < vcut]:
            del val[d]


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
    maxn = int(os.environ.get("RF_MAX", "40" if SAMPLE else "8"))   # 采样模式支持全组 28+;全量护栏仍 8
    if len(syms) > maxn:
        print(f"⚠️ 标的 {len(syms)} 超 RF_MAX={maxn},只跑前 {maxn}")
        syms = syms[:maxn]
    force = os.environ.get("RF_FORCE", "").lower() in ("1", "true")
    print(f"BASE={BASE} days={days[0]}…{days[-1]}({len(days)}) 标的={len(syms)}只 {syms} "
          f"mode={'SAMPLE' if SAMPLE else 'FULL'} key={'set' if KEY else 'MISSING'} window={WINDOW}d cap={CAP}")

    store = load_store()
    store.setdefault("validation", {})            # 采样验证:每日轮一票额外跑全量,存三方对照
    t0 = time.time()
    for day in days:                              # 逐日;每日写盘(即使后续超时也保住已完成)
        dayrec = store["days"].get(day, {})
        # 每日轮一票做验证(按日期确定,len(syms) 天轮完一圈,每票各得一次全量对照)
        val_tk = syms[date.fromisoformat(day).toordinal() % len(syms)] if (SAMPLE and syms) else None
        ok = 0
        for s in syms:                            # 串行:弱网关扛不住并发
            if s in dayrec and not force:
                ok += 1                            # 断点续跑:已采集的 (day,票) 跳过日常信号
            else:
                try:
                    r = (flow_for_sampled(s, day, time.time() + SAMPLE_SEC, verbose=True) if SAMPLE
                         else flow_for(s, day, verbose=True))
                    if r:
                        dayrec[s] = r; ok += 1
                except Exception as exc:
                    print(f"  ✗ {s} {day}: {exc}")
            # 验证票:额外跑一次全量,与采样(naive/精确)三方对照
            if SAMPLE and s == val_tk and (day not in store["validation"] or force):
                try:
                    full = flow_for(s, day, verbose=False, ticker_sec=VAL_SEC)   # 验证全量给足墙
                    samp = dayrec.get(s)
                    if full and samp:
                        store["validation"][day] = {
                            "ticker": s,
                            "full": {"netbuy": full["netbuy"], "intensity": full["intensity"]},
                            "naive": {"netbuy": samp.get("netbuy_naive"), "intensity": samp.get("intensity_naive")},
                            "precise": {"netbuy": samp["netbuy"], "intensity": samp["intensity"], "ci": samp.get("ci")},
                        }
                        print(f"  ✓ 验证 {s} {day}: full={full['netbuy']:+.3f} "
                              f"naive={samp.get('netbuy_naive')} precise={samp['netbuy']:+.3f} ci={samp.get('ci')}")
                except Exception as exc:
                    print(f"  ✗ 验证 {s} {day}: {exc}")
        store["days"][day] = dayrec
        write_store(store)
        print(f"  [{day}] {ok}/{len(syms)} 写入 · 累计 {len(store['days'])} 天 · 用时 {(time.time()-t0)/60:.0f}min")
    print(f"\n完成 {len(days)} 天 · 存 {len(store['days'])} 天 · 验证 {len(store.get('validation', {}))} 条 "
          f"→ {OUT.relative_to(ROOT)} ({OUT.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
