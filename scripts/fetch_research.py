#!/usr/bin/env python3
"""短线研究数据(Massive Stocks Advanced 档):

  全 watchlist 实时快照 · 1分钟/5分钟 K 线 · RSI/EMA 指标 · VWAP
  Short Interest(双周) + Short Volume(每日) · 期权链指标(premium/OI变化/Max Pain)

数据源:
  股票 — Massive API(https://massive.com,原 Polygon)。Stocks Advanced: 实时、无限速。
  期权 — Massive /v3/snapshot/options 需要 Options 套餐;无权限时自动回退雅虎期权链。
  K 线在 Massive 失败时也回退雅虎(5分钟)。

输出: data/research.json;OI 存档 data/oi_prev.json(算跨日 OI 变化)
"""
import bisect
import json
import math
import os
from concurrent.futures import ThreadPoolExecutor
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests
import yaml

try:
    from zoneinfo import ZoneInfo
    ET_TZ = ZoneInfo("America/New_York")
except Exception:  # noqa: BLE001
    ET_TZ = timezone.utc

ROOT = Path(__file__).resolve().parent.parent
KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
HEADERS = {"Authorization": f"Bearer {KEY}"}
# 实测网关对 REST 不限流(期权/股票突发 200+ 并发零 429),仅留极小礼貌间隔,不滥用服务器。
# 50/min 是期权 websocket 上限,与我们纯 REST 无关。
SLEEP = float(os.environ.get("MASSIVE_SLEEP", "0.08"))
OPT_SLEEP = float(os.environ.get("MASSIVE_SLEEP_OPTIONS", "0.08"))
REQ_TIMEOUT = float(os.environ.get("MASSIVE_TIMEOUT", "30"))            # 普通端点读超时
OPT_TIMEOUT = float(os.environ.get("MASSIVE_TIMEOUT_OPTIONS", "45"))    # 期权大链分页,给更长读超时
MAX_DTE = 45
MAX_EXPIRATIONS = 6
BAR_KEEP = 800  # 每粒度保留 bar 数的默认上限(各粒度在 specs 里单独指定)
# 错峰:降并发给自建网关减压——10 并发时大链(AMD/MU/TSLA/SNDK)会把网关拖到读超时 → 误回退 Yahoo。
PREFETCH_WORKERS = int(os.environ.get("PREFETCH_WORKERS", "6"))  # 阶段1 每票并发抓取(I/O bound)
PRECISE_WORKERS = int(os.environ.get("PRECISE_WORKERS", "8"))     # 精确层 top-N 合约并发逐笔

# 高频 K 线规格 (key, mult, timespan, days, yahoo_interval, yahoo_period, keep)
# keep 上限按每日约 1m~694 / 5m~175 / 15m~58 根(含盘前盘后)估算
INTRADAY_SPECS = [("bars_1m", 1, "minute", 3, "1m", "3d", 2200),
                  ("bars_5m", 5, "minute", 20, "5m", "1mo", 3600),
                  ("bars_15m", 15, "minute", 60, "15m", "60d", 3600)]


def redact(exc) -> str:
    """报错里可能带完整 URL(含 apiKey 查询参数),公开仓库的日志必须脱敏。"""
    return str(exc).replace(KEY, "***") if KEY else str(exc)


def pct_rank(hist: list, val, minn: int = 10) -> int | None:
    """val 在历史 hist 中的百分位(0-100);样本 <minn 返回 None(不足以判断)。"""
    h = [x for x in hist if x is not None]
    if val is None or len(h) < minn:
        return None
    return round(100 * sum(1 for x in h if x <= val) / len(h))


def realized_vol(bars: list, n: int = 20) -> float | None:
    """已实现波动率(n 日收盘对数收益年化),用于 VRP。bars: [t,o,h,l,c,v,vw]。"""
    if not bars or len(bars) < n + 1:
        return None
    cl = [b[4] for b in bars[-(n + 1):]]
    r = [math.log(cl[i] / cl[i - 1]) for i in range(1, len(cl)) if cl[i - 1] > 0]
    if len(r) < 2:
        return None
    m = sum(r) / len(r)
    v = sum((x - m) ** 2 for x in r) / (len(r) - 1)
    return math.sqrt(v) * math.sqrt(252)


def ewma_adv(bars: list, span: int = 20, today=None) -> float | None:
    """近期日均量(指数加权,α=2/(span+1))。剔除当天未收盘的 partial 日线,避免分母偏低。
    比双周 short 报告的 avg_daily_volume 新鲜、且无 SMA 的'暴量离窗跳变'。bars: [t,o,h,l,c,v,vw]。"""
    if not bars:
        return None
    vols = [(b[0], b[5]) for b in bars if b[5]]
    if today is not None and vols:
        last_d = datetime.fromtimestamp(vols[-1][0] / 1000, tz=timezone.utc).date()
        if last_d >= today:              # 当天(partial)→ 剔除,只用已收盘日
            vols = vols[:-1]
    if not vols:
        return None
    a = 2 / (span + 1)
    ewma = None
    for _ts, v in vols:
        ewma = v if ewma is None else a * v + (1 - a) * ewma
    return ewma


def maxpain_pin_score(spot, flip, net_gex, max_pain, iv, dte, rv, adv) -> int | None:
    """Max Pain 作为"价格磁吸目标"的可信度 0-100(启发式,权重/阈值待回测校准,见 TODO#7)。
    结构:gamma 门(乘法)× 加权几何平均(距离/到期/波动/OI),weakest-link。
    <20 当噪声 · 20-45 弱参考 · >45 才当目标看。"""
    if not (spot and max_pain and iv and dte is not None):
        return None
    sig = iv * math.sqrt(max(dte, 0.5) / 365)                 # 到期前期望振幅(比例)
    sig_abs = spot * sig
    d_sigma = abs(math.log(max_pain / spot)) / sig if sig else 9.0
    f_dist = math.exp(-0.5 * d_sigma ** 2)                    # max pain 距现价(σ 归一)
    f_time = math.exp(-dte / 5)                               # 越近到期越强
    f_vol = 1 / (1 + (rv / 0.6) ** 2) if rv else 0.5          # 越平静越强(RV 60%≈半分)
    gex_adv = abs(net_gex) / (adv * spot) * 100 if (net_gex and adv) else None
    f_oi = min(max(gex_adv / 1.5, 0.05), 1.0) if gex_adv is not None else 0.5  # 期权尾巴能否摇动股票
    if flip is not None and sig_abs:                          # gamma 门:正 gamma 才有钉
        z = (spot - flip) / sig_abs
    else:
        z = 1.0 if (net_gex or 0) > 0 else -1.0               # flip 越界时退化用 net 符号(粗,见 TODO#7b)
    gate = 1 / (1 + math.exp(-1.5 * z))
    core = (f_dist ** 0.35) * (f_time ** 0.25) * (f_vol ** 0.25) * (f_oi ** 0.15)
    return round(100 * gate * core)


def mget(path: str, **params):
    url = path if path.startswith("http") else f"{BASE}{path}"
    if KEY:
        params.setdefault("apiKey", KEY)  # 兼容只认查询参数的网关;官方两种都支持
    # 期权端点(链快照 + 单合约逐笔成交)共用 50/分钟额度,单独降速
    is_opt = "/v3/snapshot/options/" in url or "/v3/trades/O" in url or "/v3/quotes/O" in url
    sleep = OPT_SLEEP if is_opt else SLEEP
    timeout = OPT_TIMEOUT if is_opt else REQ_TIMEOUT
    resp, last_exc = None, None
    for attempt in range(4):
        try:
            resp = requests.get(url, params=params, headers=HEADERS, timeout=timeout)
        except (requests.Timeout, requests.ConnectionError) as exc:  # 网关瞬时慢/断:退避重试(错峰),别直接回退 Yahoo
            last_exc = exc
            time.sleep(1.5 * (attempt + 1))
            continue
        if resp.status_code == 429:
            time.sleep(62)
            continue
        resp.raise_for_status()
        time.sleep(sleep)
        return resp.json()
    if resp is not None:
        resp.raise_for_status()
    raise last_exc if last_exc else RuntimeError(f"mget 重试耗尽: {url}")


# ---------- 股票 ----------

def fetch_snapshots(symbols: list) -> dict:
    """全 watchlist 实时快照,一次调用。"""
    data = mget("/v2/snapshot/locale/us/markets/stocks/tickers",
                tickers=",".join(symbols))
    out = {}
    for t in data.get("tickers") or []:
        last = (t.get("lastTrade") or {}).get("p")
        day = t.get("day") or {}
        out[t["ticker"]] = {
            "price": last or day.get("c"),
            "chg": t.get("todaysChange"),
            "chg_pct": t.get("todaysChangePerc"),
            "day_vol": day.get("v"),
            "prev_close": (t.get("prevDay") or {}).get("c"),
        }
    return out


def fetch_bars(sym: str, mult: int, timespan: str, days: int, keep: int = BAR_KEEP) -> list:
    """K 线 [t(ms), o, h, l, c, v, vw];keep 为该粒度最多保留的 bar 数。"""
    to = date.today()
    frm = to - timedelta(days=days)
    data = mget(f"/v2/aggs/ticker/{sym}/range/{mult}/{timespan}/{frm}/{to}",
                adjusted="true", sort="asc", limit=50000)
    return [[r["t"], r["o"], r["h"], r["l"], r["c"], r["v"], r.get("vw")]
            for r in (data.get("results") or [])][-keep:]


def bars_yahoo(sym: str, interval: str, period: str, keep: int = BAR_KEEP) -> list:
    """雅虎 K 线回退(免费,盘中约 15 分钟内延迟)。"""
    import yfinance as yf
    df = yf.Ticker(sym).history(period=period, interval=interval)
    return [[int(ts.timestamp() * 1000),
             round(float(r["Open"]), 4), round(float(r["High"]), 4),
             round(float(r["Low"]), 4), round(float(r["Close"]), 4),
             int(r["Volume"]), None]
            for ts, r in df.iterrows()][-keep:]


def fetch_short(sym: str) -> dict:
    rows = (mget("/stocks/v1/short-interest", ticker=sym, limit=1,
                 sort="settlement_date.desc").get("results")) or []
    if not rows:
        raise ValueError("没有 short interest 数据")
    r = rows[0]
    return {"short_interest": r.get("short_interest"),
            "days_to_cover": r.get("days_to_cover"),
            "avg_daily_volume": r.get("avg_daily_volume"),
            "settlement_date": r.get("settlement_date")}


def fetch_short_volume(sym: str) -> list:
    """每日空头成交占比,近 5 个交易日。"""
    rows = (mget("/stocks/v1/short-volume", ticker=sym, limit=5,
                 sort="date.desc").get("results")) or []
    out = []
    for r in rows:
        short = r.get("short_volume")
        total = r.get("total_volume") or r.get("volume")
        out.append({"date": r.get("date"),
                    "short_volume": short, "total_volume": total,
                    "ratio": round(short / total, 3) if short and total else None})
    return out


def fetch_news(sym: str) -> list:
    """Massive ticker 新闻(近 3 天,带每票情绪分析)。所有 Stocks 档位可用。"""
    since = (datetime.now(timezone.utc) - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = (mget("/v2/reference/news", ticker=sym, limit=15,
                 sort="published_utc", order="desc",
                 **{"published_utc.gte": since}).get("results")) or []
    out = []
    for r in rows:
        senti = next((i for i in (r.get("insights") or []) if i.get("ticker") == sym), {})
        out.append({
            "title": r.get("title"),
            "url": r.get("article_url"),
            "published": r.get("published_utc"),
            "source": (r.get("publisher") or {}).get("name"),
            "summary": (r.get("description") or "")[:300],
            "sentiment": senti.get("sentiment"),
            "reason": senti.get("sentiment_reasoning"),
        })
    return out


def session_vwap(bars_1m: list) -> float | None:
    """当日(最后一个交易日)VWAP,由 1 分钟线计算。"""
    if not bars_1m:
        return None
    last_day = datetime.fromtimestamp(bars_1m[-1][0] / 1000, tz=timezone.utc).date()
    pv = vol = 0.0
    for b in bars_1m:
        if datetime.fromtimestamp(b[0] / 1000, tz=timezone.utc).date() != last_day:
            continue
        price = b[6] if b[6] else (b[2] + b[3] + b[4]) / 3
        pv += price * b[5]
        vol += b[5]
    return round(pv / vol, 2) if vol else None


# ---------- 期权 ----------

def rsi(closes: list, n: int = 14) -> float | None:
    """Wilder RSI,本地从收盘价算(替代按次计费的指标端点)。"""
    if len(closes) <= n:
        return None
    gains = losses = 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0); losses += max(-d, 0)
    ag, al = gains / n, losses / n
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        ag = (ag * (n - 1) + max(d, 0)) / n
        al = (al * (n - 1) + max(-d, 0)) / n
    if al == 0:
        return 100.0
    return round(100 - 100 / (1 + ag / al), 2)


def ema_last(closes: list, n: int) -> float | None:
    """EMA 末值,本地算。"""
    if len(closes) < n:
        return None
    k = 2 / (n + 1)
    e = sum(closes[:n]) / n
    for c in closes[n:]:
        e = c * k + e * (1 - k)
    return round(e, 2)


def bs_gamma(spot: float, strike: float, t_years: float, iv: float) -> float:
    """Black-Scholes gamma,雅虎回退时由 IV 现算(Massive 链自带 gamma)。"""
    import math
    if not iv or iv <= 0 or t_years <= 0 or spot <= 0 or strike <= 0:
        return 0.0
    d1 = (math.log(spot / strike) + (0.04 + iv * iv / 2) * t_years) / (iv * math.sqrt(t_years))
    return math.exp(-d1 * d1 / 2) / math.sqrt(2 * math.pi) / (spot * iv * math.sqrt(t_years))


# GEX 按到期分桶(累计口径,0dte ⊂ week ⊂ 2wk ⊂ 30d),前端可切,默认 0DTE
# 内部键仍叫 "all"(避免动数据格式),语义=≤30d;仍抓 ≤MAX_DTE 供 IV 期限结构,只是 GEX 顶桶封在 30d
GEX_BUCKETS = [("0dte", 0), ("week", 7), ("2wk", 14), ("all", 30)]


def _gex_summary(signed: dict, spot: float) -> dict:
    """把 {strike: 带符号的 gamma×OI 之和} 汇总为 net_gex / flip / by_strike(现价±25%)。"""
    scale = 100 * spot * spot * 0.01
    rows = [{"strike": k, "net": v * scale} for k, v in sorted(signed.items())]
    crossings, cum, prev_cum, prev_k = [], 0.0, None, None
    for r in rows:
        cum += r["net"]
        if prev_cum is not None and (prev_cum < 0) != (cum < 0):
            crossings.append((prev_k + r["strike"]) / 2)
        prev_cum, prev_k = cum, r["strike"]
    lo, hi = spot * 0.75, spot * 1.25
    return {
        "net_gex": sum(r["net"] for r in rows),
        "flip": round(min(crossings, key=lambda k: abs(k - spot)), 2) if crossings else None,
        "by_strike": [r for r in rows if lo <= r["strike"] <= hi],
    }


def _contract_gamma_oi(c: dict, spot: float, today) -> float | None:
    """单合约 gamma×OI(gamma 缺失时由 IV 现算)。"""
    oi = c["oi"]
    if not oi:
        return None
    g = c.get("gamma")
    if not g:
        g = bs_gamma(spot, c["strike"], ((date.fromisoformat(c["exp"]) - today).days + 0.5) / 365,
                     c.get("iv") or 0)
    return g * oi if g else None


def _bucketize(enriched: list, spot: float) -> dict:
    """enriched: [(dte, strike, signed gamma×oi)] → 按到期桶汇总。"""
    if not enriched:
        return None
    buckets = {}
    for name, cap in GEX_BUCKETS:
        signed = {}
        for dte, strike, val in enriched:
            if 0 <= dte <= cap:
                signed[strike] = signed.get(strike, 0.0) + val
        buckets[name] = _gex_summary(signed, spot) if signed \
            else {"net_gex": 0.0, "flip": None, "by_strike": []}
    a = buckets["all"]
    return {"spot": round(spot, 2), "buckets": buckets,
            "net_gex": a["net_gex"], "flip": a["flip"], "by_strike": a["by_strike"]}


def compute_gex(contracts: list, spot: float) -> dict | None:
    """名义 GEX:call 正、put 负;按到期分桶。"""
    if not spot:
        return None
    today = date.today()
    enriched = []
    for c in contracts:
        go = _contract_gamma_oi(c, spot, today)
        if go is None:
            continue
        sign = 1 if c["type"] == "call" else -1
        enriched.append(((date.fromisoformat(c["exp"]) - today).days, c["strike"], sign * go))
    return _bucketize(enriched, spot)


# ---------- 流量分类 GEX(top-N 活跃合约按真实买卖方向定 dealer 符号) ----------
# 保留的单腿常规成交条件码之外一律排除(多腿/组合/取消/迟到/拍卖/交叉/盘后)
FLOW_BAD_CONDITIONS = {201, 202, 203, 204, 205, 206, 207, 208, 210, 227, 228, 229, 230,
                       232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244,
                       245, 246, 247, 248}
FLOW_SKIP = {"SPY", "QQQ", "SOXX", "IWM", "DIA", "IVV", "VOO", "SMH", "XLK"}  # ETF/指数期权面太大
FLOW_TOPN = int(os.environ.get("FLOW_TOPN", "40"))
FLOW_STRIKE_BAND = 0.15
FLOW_MAX_DTE = 14
SPREAD_MAX = float(os.environ.get("FLOW_SPREAD_MAX", "0.25"))  # 价差/中价 > 此值视为脏,不信其判向
QUOTE_PAGE_CAP = int(os.environ.get("FLOW_QUOTE_PAGES", "4"))  # 逐条 NBBO 分页上限(limit=5万,一天通常 1 页)


def snapshot_side(c: dict) -> str | None:
    """用 snapshot 的 last_trade 对 last_quote(NBBO)判主动买卖方向(quote rule)。
    价差过宽 / 无买卖盘 → None(脏,不信)。分层判向:
    ① 触碰(≥ask/≤bid)—— 最强信号;② 价差内退到中价规则(>中价买/<中价卖,标准 Lee-Ready)
    ③ 正好打在中价 → None(真歧义)。全程比同时刻买卖盘,免疫 tick rule 的 delta 污染。"""
    bid, ask, lt = c.get("bid"), c.get("ask"), c.get("lt")
    if not bid or not ask or bid <= 0 or ask <= 0 or lt is None:
        return None
    mid = (bid + ask) / 2
    if mid <= 0 or (ask - bid) / mid > SPREAD_MAX:  # 价差过滤
        return None
    if lt >= ask:
        return "buy"
    if lt <= bid:
        return "sell"
    if lt > mid:   # 价差内:退到中价规则
        return "buy"
    if lt < mid:
        return "sell"
    return None    # 正好在中价:无法判向(计入歧义)


def update_flow_accum(contracts: list, acc: dict, today_str: str, spot: float, today) -> None:
    """快照采样版流量累积(每轮调,零额外 API):对近价合约,把本轮成交量增量按
    last_trade vs NBBO 的方向累加到当日 buy/sell。acc 结构 {date, c:{ticker:[vol,buy,sell,flat]}}。
    误差:一段增量按"最后一笔"的方向记账(采样噪声,随机偏多),但免疫 delta 系统偏差。"""
    if acc.get("date") != today_str:
        acc.clear(); acc["date"] = today_str; acc["c"] = {}
    C = acc["c"]
    lo, hi = spot * (1 - FLOW_STRIKE_BAND), spot * (1 + FLOW_STRIKE_BAND)
    for c in contracts:
        tk = c.get("ticker")
        if not tk or not (lo <= c["strike"] <= hi):
            continue
        if not 0 <= (date.fromisoformat(c["exp"]) - today).days <= FLOW_MAX_DTE:
            continue
        vol = c.get("vol") or 0
        prev = C.get(tk)
        pv, b, s, f = (prev if prev else [0, 0.0, 0.0, 0.0])
        dvol = vol - pv
        if dvol < 0:  # 数据重置/回退,重新以当前累计量计
            dvol = vol
        if dvol > 0:
            side = snapshot_side(c)
            if side == "buy":
                b += dvol
            elif side == "sell":
                s += dvol
            else:
                f += dvol  # 中价 / 脏价差 → 未判向
        C[tk] = [vol, b, s, f]


def compute_gex_flow_sampled(sym: str, spot: float, contracts: list, acc: dict, today,
                             precise: dict | None = None) -> dict | None:
    """用累积的 buy/sell 定 dealer 符号,产出流量版 GEX。
    客户净买 → dealer 净空 → 空 gamma → 符号 -1;未判向合约退回名义符号。
    precise:top-N 逐笔 Lee-Ready 的净签名 {ticker: net},在这些高权重合约上覆盖采样判向。"""
    if not spot or sym in FLOW_SKIP:
        return None
    # 累加器 acc 是全票共享(key=OCC),这里只取本票的合约:O:{SYM} 后紧跟到期日数字,
    # 避免 classified/ambiguity 混入别的票(如 O:MU 误配 O:MULN)。
    pfx = f"O:{sym}"
    is_sym = lambda tk: tk.startswith(pfx) and tk[len(pfx):len(pfx) + 1].isdigit()
    Csym = {tk: v for tk, v in acc.get("c", {}).items() if is_sym(tk)}
    flow_sign = {}
    for tk, (v, b, s, f) in Csym.items():        # 采样版判向(本票近价链)
        if b + s > 0 and b != s:
            flow_sign[tk] = -1 if b > s else 1
    prec_used = set()
    for tk, net in (precise or {}).items():       # 精确层覆盖(本票 top-N 高权重合约)
        if net != 0 and is_sym(tk):
            flow_sign[tk] = -1 if net > 0 else 1
            prec_used.add(tk)
    if not flow_sign:
        return None
    lo, hi = spot * (1 - FLOW_STRIKE_BAND), spot * (1 + FLOW_STRIKE_BAND)
    enriched = []
    for c in contracts:
        go = _contract_gamma_oi(c, spot, today)
        if go is None:
            continue
        sign = flow_sign.get(c.get("ticker"), 1 if c["type"] == "call" else -1)
        enriched.append(((date.fromisoformat(c["exp"]) - today).days, c["strike"], sign * go))
    out = _bucketize(enriched, spot)
    if out:
        out["classified"] = len(flow_sign)
        out["method"] = "sampled+precise" if prec_used else "sampled"
        cand = [c for c in contracts if lo <= c["strike"] <= hi
                and 0 <= (date.fromisoformat(c["exp"]) - today).days <= FLOW_MAX_DTE]
        g_cand = sum((_contract_gamma_oi(c, spot, today) or 0) for c in cand)
        g_clf = sum((_contract_gamma_oi(c, spot, today) or 0) for c in cand if c.get("ticker") in flow_sign)
        out["coverage"] = round(g_clf / g_cand, 3) if g_cand else None
        out["precise_n"] = len([t for t in prec_used if any(c.get("ticker") == t for c in cand)])
        tb = sum(v[1] for v in Csym.values()); ts = sum(v[2] for v in Csym.values()); tf = sum(v[3] for v in Csym.values())
        out["ambiguity"] = round(tf / (tb + ts + tf), 3) if (tb + ts + tf) else None
    return out


def oi_flow_rows(sym: str, contracts: list, flow_c: dict, spot: float, today) -> list:
    """前向记录:近价 ≤14DTE 合约的 [exp, strike, C/P, 当前OI, 当日主动净(buy−sell), gamma]。
    供离线 eval 用「跨日 ΔOI × 当日主动方向」估客户开/平仓四象限(long/short × call/put)→ pilot 真持仓输入。
    API 无开平仓/历史OI,只能这样前向攒;时序对齐(OI 结算 T+1)留给离线处理。"""
    if not spot or sym in FLOW_SKIP:
        return []
    lo, hi = spot * (1 - FLOW_STRIKE_BAND), spot * (1 + FLOW_STRIKE_BAND)
    rows = []
    for c in contracts:
        if not (lo <= c["strike"] <= hi):
            continue
        if not 0 <= (date.fromisoformat(c["exp"]) - today).days <= FLOW_MAX_DTE:
            continue
        acc = flow_c.get(c.get("ticker"))
        aggr = (acc[1] - acc[2]) if acc else 0.0        # 当日 Lee-Ready 主动净(买−卖)
        g = c.get("gamma") or bs_gamma(spot, c["strike"],
              ((date.fromisoformat(c["exp"]) - today).days + 0.5) / 365, c.get("iv") or 0)
        rows.append([c["exp"], c["strike"], "C" if c["type"] == "call" else "P",
                     c.get("oi") or 0, round(aggr, 1), round(g or 0, 6)])
    return rows


def iv_obs_rows(sym: str, contracts: list, today) -> dict:
    """零风险观测:取最接近 30 DTE 的到期,导出该到期每张合约的 [strike, C/P, delta, iv, mid]。
    供离线分析 ±20% 抓取带内 25Δ/50Δ 是否可达、翼部 delta 覆盖如何。不参与任何指标,可随时删。"""
    cs = [c for c in contracts if c.get("exp")]
    if not cs:
        return {}
    near = min({c["exp"] for c in cs}, key=lambda e: abs((date.fromisoformat(e) - today).days - 30))
    rows = sorted(
        [[c["strike"], "C" if c["type"] == "call" else "P",
          round(c["delta"], 3) if c.get("delta") is not None else None,
          round(c["iv"], 4) if c.get("iv") is not None else None, c.get("mid")]
         for c in cs if c["exp"] == near],
        key=lambda r: r[0])
    return {"exp": near, "dte": (date.fromisoformat(near) - today).days, "rows": rows}


def gex_profile_rows(gex: dict, buckets=("week", "2wk", "all")) -> list:
    """EOD GEX 形状:每桶 by_strike 的 (bucket, strike, net_nom, net_real)。
    供离线研究"墙的厚度/长度/距现价/符号 → 后续当周价格引力/推力"。real 缺失(ETF/无flow)→ None。"""
    nb = gex.get("buckets") or {}
    fb = (gex.get("flow") or {}).get("buckets") or {}
    rows = []
    for b in buckets:
        nom = {r["strike"]: r["net"] for r in (nb.get(b) or {}).get("by_strike", [])}
        real = {r["strike"]: r["net"] for r in (fb.get(b) or {}).get("by_strike", [])}
        for k in sorted(set(nom) | set(real)):
            rows.append((b, k, nom.get(k), real.get(k)))
    return rows


def fetch_option_trades(contract_ticker: str) -> list:
    """单合约当日逐笔成交(时间升序),返回 [(sip_ts, price, size, conditions)]。"""
    out, url, pages = [], f"/v3/trades/{contract_ticker}?limit=50000&order=asc&sort=timestamp", 0
    while url and pages < 3:
        d = mget(url)
        for t in d.get("results") or []:
            out.append((t.get("sip_timestamp"), t.get("price"), t.get("size") or 0, t.get("conditions") or []))
        url = rebase_url(d.get("next_url"))
        pages += 1
    return out


def fetch_option_quotes(contract_ticker: str) -> list:
    """单合约当日逐条 NBBO(时间升序),返回 [(sip_ts, bid, ask)]。
    limit=50000 时一天(~1万条)通常一页装下,故 QUOTE_PAGE_CAP 很小即可。"""
    out, url, pages = [], f"/v3/quotes/{contract_ticker}?limit=50000&order=asc&sort=timestamp", 0
    while url and pages < QUOTE_PAGE_CAP:
        d = mget(url)
        for q in d.get("results") or []:
            out.append((q.get("sip_timestamp"), q.get("bid_price"), q.get("ask_price")))
        url = rebase_url(d.get("next_url"))
        pages += 1
    return out


def classify_lee_ready(trades: list, quotes: list) -> tuple[float, float, float]:
    """逐笔 Lee-Ready:对每笔成交,用其成交时刻(sip_ts)前最近的 NBBO 判向 —
    ≥ask 买 / ≤bid 卖(触碰);价差内 >中价 买 / <中价 卖(中价规则);
    正好中价或无报价 → tick rule 回退。size 加权。
    比 tick rule 精确:比的是与同时刻买卖盘的关系,免疫标的涨跌带来的价格漂移。
    → (净=买size−卖size, 已判向size, 平价size)。"""
    q = sorted([x for x in quotes if x[0] and x[1] and x[2]], key=lambda x: x[0])
    qts = [x[0] for x in q]
    buy = sell = flat = 0.0
    prev = None
    last_dir = 0
    for ts, price, size, conds in sorted(trades, key=lambda t: t[0] or 0):
        if price is None or not size or any(c in FLOW_BAD_CONDITIONS for c in conds):
            continue
        side = 0
        if ts is not None and qts:
            i = bisect.bisect_right(qts, ts) - 1  # 成交时刻前最近的一条 NBBO
            if i >= 0:
                _, bid, ask = q[i]
                mid = (bid + ask) / 2
                if price >= ask:
                    side = 1
                elif price <= bid:
                    side = -1
                elif price > mid:   # 价差内:退到中价规则
                    side = 1
                elif price < mid:
                    side = -1
        if side == 0:  # 无报价 / 正好中价 → tick rule 回退(现在只剩这两种)
            side = 1 if (prev is not None and price > prev) else -1 if (prev is not None and price < prev) else last_dir
        prev = price
        if side > 0:
            buy += size; last_dir = 1
        elif side < 0:
            sell += size; last_dir = -1
        else:
            flat += size
    return buy - sell, buy + sell, flat


def compute_flow_precise(sym: str, spot: float, contracts: list, today, errors: list) -> dict:
    """对 top-N(按 gamma×OI 权重,而非成交量)高权重合约做逐笔 Lee-Ready,
    返回 {ticker: 净签名size}。贵(每合约拉 trades+quotes),故低频跑(FLOW_PRECISE)。
    结果作为「精确层」覆盖采样版在这些高权重合约上的判向。"""
    if not spot or sym in FLOW_SKIP:
        return {}
    lo, hi = spot * (1 - FLOW_STRIKE_BAND), spot * (1 + FLOW_STRIKE_BAND)
    cand = [c for c in contracts if c.get("ticker") and c["vol"] and lo <= c["strike"] <= hi
            and 0 <= (date.fromisoformat(c["exp"]) - today).days <= FLOW_MAX_DTE]
    ranked = sorted(cand, key=lambda c: -(_contract_gamma_oi(c, spot, today) or 0))[:FLOW_TOPN]

    def _one(c):  # 单合约逐笔:拉 trades+quotes 归并判向。返回 (ticker, net|None, err|None)
        try:
            net, sz, _flat = classify_lee_ready(fetch_option_trades(c["ticker"]),
                                                fetch_option_quotes(c["ticker"]))
            return (c["ticker"], net if sz > 0 else None, None)
        except Exception as exc:  # noqa: BLE001 单合约失败不影响整体
            return (c["ticker"], None, f"{sym} 精确流量 {c['ticker']}: {redact(exc)}")

    out = {}
    with ThreadPoolExecutor(max_workers=PRECISE_WORKERS) as ex:  # top-N 合约并发抓取
        for tk, net, err in ex.map(_one, ranked):
            if err:
                errors.append(err)
            elif net is not None:
                out[tk] = net
    return out


def rebase_url(url: str | None) -> str | None:
    """分页 next_url 可能指向官方域名,重写到配置的基址(自定义网关场景)。"""
    if not url:
        return None
    from urllib.parse import urlparse
    p = urlparse(url)
    return f"{BASE}{p.path}" + (f"?{p.query}" if p.query else "")


OPT_FETCH_BAND = 0.20  # 期权只抓现价 ±20% 的行权价,大幅减少 SPY/QQQ 分页


def options_massive(sym: str, spot: float | None = None) -> list:
    from urllib.parse import urlencode
    today = date.today()
    params = {"limit": 250,
              "expiration_date.gte": today.isoformat(),
              "expiration_date.lte": (today + timedelta(days=MAX_DTE)).isoformat()}
    if spot:  # 服务端行权价过滤,减少页数
        params["strike_price.gte"] = round(spot * (1 - OPT_FETCH_BAND), 2)
        params["strike_price.lte"] = round(spot * (1 + OPT_FETCH_BAND), 2)
    contracts, url = [], f"/v3/snapshot/options/{sym}?{urlencode(params)}"
    while url:
        data = mget(url)
        for o in data.get("results") or []:
            det = o.get("details") or {}
            exp = det.get("expiration_date")
            if not exp or not 0 <= (date.fromisoformat(exp) - today).days <= MAX_DTE:
                continue
            day = o.get("day") or {}
            lq = o.get("last_quote") or {}   # 实时 NBBO,用于快照采样判向 + 价差过滤
            lt = o.get("last_trade") or {}   # 最近一笔成交
            contracts.append({
                "ticker": det.get("ticker"),  # OCC 代码,拉逐笔成交用
                "type": det.get("contract_type"),
                "strike": det.get("strike_price"),
                "exp": exp,
                "iv": o.get("implied_volatility"),
                "gamma": (o.get("greeks") or {}).get("gamma"),
                "oi": o.get("open_interest") or 0,
                "vol": day.get("volume") or 0,
                "price": day.get("vwap") or day.get("close") or 0,
                "bid": lq.get("bid"),
                "ask": lq.get("ask"),
                "lt": lt.get("price"),        # 最近成交价(对 bid/ask 判主动买卖)
                "delta": (o.get("greeks") or {}).get("delta"),  # 观测:供后续 25Δ/50Δ 选取(同一响应,零额外 API)
                "mid": round((lq["bid"] + lq["ask"]) / 2, 4) if (lq.get("bid") and lq.get("ask")) else None,
            })
        url = rebase_url(data.get("next_url"))
    return contracts


INDEX_BAND = float(os.environ.get("INDEX_BAND", "0.05"))    # 指数期权近价带宽(链大,收窄)
INDEX_MAX_DTE = int(os.environ.get("INDEX_MAX_DTE", "7"))   # 只取近月(0DTE+本周,主导盘中 gamma)


def fetch_index_gex(sym: str, errors: list) -> dict | None:
    """抓 I:{sym} 指数期权(主池,如 SPX)算真·指数 GEX,替换 ETF 切片。
    - 用 `I:` 前缀才带 greeks;spot 从 snapshot 的 `underlying_asset.value` 取(指数 aggs/indices 未授权)。
    - 链很大 → 只取近价 ±INDEX_BAND、≤INDEX_MAX_DTE。指数 dealer 系统性空 gamma,nominal 符号即校准,不需 Real。
    返回 compute_gex 的结果(net_gex/flip/by_strike/buckets),失败返回 None。"""
    if not KEY:
        return None
    from urllib.parse import urlencode
    u = f"I:{sym}"
    try:
        d0 = mget(f"/v3/snapshot/options/{u}", limit=1)              # 1 个合约即带 underlying_asset.value
        spot = ((d0.get("results") or [{}])[0].get("underlying_asset") or {}).get("value")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"{sym} 指数 spot: {redact(exc)}"); return None
    if not spot:
        return None
    today = date.today()
    params = {"limit": 250,
              "strike_price.gte": round(spot * (1 - INDEX_BAND), 2), "strike_price.lte": round(spot * (1 + INDEX_BAND), 2),
              "expiration_date.gte": today.isoformat(), "expiration_date.lte": (today + timedelta(days=INDEX_MAX_DTE)).isoformat()}
    contracts, url = [], f"/v3/snapshot/options/{u}?{urlencode(params)}"
    while url:
        data = mget(url)
        for o in data.get("results") or []:
            det = o.get("details") or {}
            exp = det.get("expiration_date")
            if not exp or not 0 <= (date.fromisoformat(exp) - today).days <= INDEX_MAX_DTE:
                continue
            contracts.append({"ticker": det.get("ticker"), "type": det.get("contract_type"),
                              "strike": det.get("strike_price"), "exp": exp,
                              "iv": o.get("implied_volatility"), "gamma": (o.get("greeks") or {}).get("gamma"),
                              "oi": o.get("open_interest") or 0, "vol": (o.get("day") or {}).get("volume") or 0})
        url = rebase_url(data.get("next_url"))
    gex = compute_gex(contracts, spot)
    if gex:
        gex["spot"] = spot
        gex["index"] = sym    # 标记:主池指数 GEX(非 ETF 切片),值=指数名
    return gex


def merge_index_into_etf(etf_gex: dict, idx_gex: dict, ratio: float) -> dict:
    """把指数主池 GEX 按 strike/ratio 归并进 ETF 的 GEX(逐桶):by_strike 的 net 相加、行权价 ÷ratio 落到
    ETF 价格轴(SPX→SPY 用 ratio=SPX/SPY≈10)。net 单位=$/1% 波动,指数与 ETF 同步 → 可加。就地改 etf_gex。
    结果:SPY 的梯/图显示真·标普总 gamma(SPX 主池 + SPY 自身),标 merged_index。"""
    if not etf_gex or not idx_gex or not ratio:
        return etf_gex
    eb = etf_gex.get("buckets") or {}
    ib = idx_gex.get("buckets") or {}
    spot = etf_gex.get("spot")
    snap = lambda k: round(k * 2) / 2                            # 落 0.5 网格,让 ETF 与指数档对齐合并
    for name, e in eb.items():
        i = ib.get(name) or {}
        agg: dict = {}
        for r in e.get("by_strike") or []:                       # ETF 自身档
            agg[snap(r["strike"])] = agg.get(snap(r["strike"]), 0.0) + r["net"]
        for r in i.get("by_strike") or []:                       # 指数档 → ÷ratio 落 ETF 轴
            k = snap(r["strike"] / ratio)
            agg[k] = agg.get(k, 0.0) + r["net"]
        rows = [{"strike": k, "net": round(v, 2)} for k, v in sorted(agg.items())]
        cross, cum, pc, pk = [], 0.0, None, None                 # flip 重算(累计变号,取近 spot)
        for r in rows:
            cum += r["net"]
            if pc is not None and (pc < 0) != (cum < 0):
                cross.append((pk + r["strike"]) / 2)
            pc, pk = cum, r["strike"]
        e["by_strike"] = rows
        e["net_gex"] = (e.get("net_gex") or 0) + (i.get("net_gex") or 0)   # 真总量 = 两桶净值相加
        e["flip"] = round(min(cross, key=lambda x: abs(x - spot)), 2) if (cross and spot) else None
    a = eb.get("all") or {}
    etf_gex["net_gex"] = a.get("net_gex")
    etf_gex["flip"] = a.get("flip")
    etf_gex["by_strike"] = a.get("by_strike")
    etf_gex["merged_index"] = idx_gex.get("index") or "index"
    return etf_gex


def options_yahoo(sym: str) -> list:
    import yfinance as yf
    tk = yf.Ticker(sym)
    today = date.today()
    picked = [d for d in tk.options
              if 0 <= (date.fromisoformat(d) - today).days <= MAX_DTE][:MAX_EXPIRATIONS]
    contracts = []
    for d in picked:
        chain = tk.option_chain(d)
        for typ, df in (("call", chain.calls), ("put", chain.puts)):
            for row in df.itertuples():
                oi = 0 if row.openInterest != row.openInterest else int(row.openInterest)
                vol = 0 if row.volume != row.volume else int(row.volume)
                price = 0 if row.lastPrice != row.lastPrice else float(row.lastPrice)
                iv = None if row.impliedVolatility != row.impliedVolatility else float(row.impliedVolatility)
                bid = 0.0 if row.bid != row.bid else float(row.bid)
                ask = 0.0 if row.ask != row.ask else float(row.ask)
                contracts.append({"type": typ, "strike": float(row.strike), "exp": d,
                                  "iv": iv, "oi": oi, "vol": vol, "price": price,
                                  "bid": bid or None, "ask": ask or None,
                                  "mid": round((bid + ask) / 2, 4) if (bid and ask) else None})
                                  # 注:Yahoo 无 greeks,delta 缺省(观测主要看 Massive 源)
        time.sleep(0.5)
    return contracts


def max_pain(contracts: list, exp: str) -> float | None:
    """最近到期日的 Max Pain:使期权持有者总收益最小的结算价。"""
    rows = [c for c in contracts if c["exp"] == exp and c["oi"]]
    strikes = sorted({c["strike"] for c in rows})
    if not strikes:
        return None
    best, best_pain = None, None
    for p in strikes:
        pain = sum(c["oi"] * max(p - c["strike"], 0) for c in rows if c["type"] == "call") \
             + sum(c["oi"] * max(c["strike"] - p, 0) for c in rows if c["type"] == "put")
        if best_pain is None or pain < best_pain:
            best, best_pain = p, pain
    return best


def summarize_options(sym: str, contracts: list, spot: float | None,
                      oi_prev: dict, oi_next: dict) -> dict:
    s = {"call_premium": 0.0, "put_premium": 0.0, "call_vol": 0, "put_vol": 0,
         "call_oi": 0, "put_oi": 0}
    by_exp: dict[str, dict] = {}
    ivs = []
    for c in contracts:
        side = "call" if c["type"] == "call" else "put"
        prem = c["vol"] * c["price"] * 100
        s[f"{side}_premium"] += prem
        s[f"{side}_vol"] += c["vol"]
        s[f"{side}_oi"] += c["oi"]
        e = by_exp.setdefault(c["exp"], {"call_premium": 0.0, "put_premium": 0.0,
                                         "call_vol": 0, "put_vol": 0,
                                         "call_oi": 0, "put_oi": 0, "_ivs": []})
        e[f"{side}_premium"] += prem
        e[f"{side}_vol"] += c["vol"]
        e[f"{side}_oi"] += c["oi"]
        if spot and c["iv"] and abs(c["strike"] - spot) / spot <= 0.03:
            ivs.append((c["exp"], c["iv"]))
            e["_ivs"].append(c["iv"])
        oi_next[f"{sym}|{c['exp']}|{c['strike']}|{side}"] = c["oi"]

    if ivs:
        nearest = min(e for e, _ in ivs)
        vals = [v for e, v in ivs if e == nearest]
        s["atm_iv"] = sum(vals) / len(vals)
        # IV skew(最近到期):~7% OTM put 与 call 的 IV 之差(risk reversal 代理)
        # rr>0 = 看跌保护更贵 = 恐慌/看跌倾向;rr<0 = call 更贵 = 投机/看涨
        if spot:
            ne_c = [c for c in contracts if c["exp"] == nearest and c.get("iv")]
            def _iv_near(target, typ):
                cs = [c for c in ne_c if c["type"] == typ]
                return min(cs, key=lambda c: abs(c["strike"] - target)) if cs else None
            pk = _iv_near(spot * 0.93, "put")
            ck = _iv_near(spot * 1.07, "call")
            if pk and ck:
                s["iv_skew"] = {"exp": nearest, "put_iv": round(pk["iv"], 4), "put_k": pk["strike"],
                                "call_iv": round(ck["iv"], 4), "call_k": ck["strike"],
                                "rr": round(pk["iv"] - ck["iv"], 4)}
    s["pcr_vol"] = round(s["put_vol"] / s["call_vol"], 2) if s["call_vol"] else None
    s["pcr_oi"] = round(s["put_oi"] / s["call_oi"], 2) if s["call_oi"] else None
    # 注意:premium 为成交总额(不分买卖方向),净额是"活跃度"指标而非方向指标
    s["net_premium"] = s["call_premium"] - s["put_premium"]
    s["pcr_prem"] = round(s["put_premium"] / s["call_premium"], 2) if s["call_premium"] else None

    s["by_expiry"] = [{"exp": e,
                       **{k: v for k, v in d.items() if k != "_ivs"},
                       "atm_iv": (sum(d["_ivs"]) / len(d["_ivs"])) if d["_ivs"] else None}
                      for e, d in sorted(by_exp.items())][:MAX_EXPIRATIONS]

    # 按行权价聚合的 OI/成交量(交易页行权价梯用),现价 ±25%
    strike_agg: dict[float, dict] = {}
    for c in contracts:
        side = "call" if c["type"] == "call" else "put"
        a = strike_agg.setdefault(c["strike"], {"call_oi": 0, "put_oi": 0,
                                                "call_vol": 0, "put_vol": 0})
        a[f"{side}_oi"] += c["oi"]
        a[f"{side}_vol"] += c["vol"]
    if spot:
        lo, hi = spot * 0.75, spot * 1.25
        strike_agg = {k: v for k, v in strike_agg.items() if lo <= k <= hi}
    s["by_strike"] = [{"strike": k, **v} for k, v in sorted(strike_agg.items())]

    # 当日最活跃行权价(按成交量)
    s["top_strikes"] = [{"exp": c["exp"], "strike": c["strike"],
                         "side": "call" if c["type"] == "call" else "put",
                         "vol": c["vol"], "oi": c["oi"],
                         "premium": c["vol"] * c["price"] * 100}
                        for c in sorted(contracts, key=lambda c: -c["vol"])[:8] if c["vol"]]

    exps = sorted(by_exp)
    s["max_pain"] = max_pain(contracts, exps[0]) if exps else None
    s["max_pain_exp"] = exps[0] if exps else None

    # OI 变化:与上一存档对比,取变动最大的 10 条
    changes = {}
    for c in contracts:
        side = "call" if c["type"] == "call" else "put"
        prev = oi_prev.get(f"{sym}|{c['exp']}|{c['strike']}|{side}")
        if prev is None:
            continue
        delta = c["oi"] - prev
        if delta:
            k2 = (c["exp"], c["strike"], side)
            changes[k2] = changes.get(k2, 0) + delta
    s["oi_changes"] = [{"exp": e, "strike": k, "side": sd, "delta": d}
                       for (e, k, sd), d in
                       sorted(changes.items(), key=lambda kv: -abs(kv[1]))[:10]]
    return s


# ---------- 主流程 ----------

EXTRAS_TTL = int(os.environ.get("EXTRAS_TTL", "3600"))  # 指标/short/新闻/日线的刷新周期(秒)
EXTRAS_KEYS = ("short", "short_vol", "news", "bars_d", "src_d", "extras_asof")


def load_json(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text())
        except json.JSONDecodeError:
            pass
    return default


def et_day(iso: str | None) -> str | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso).astimezone(ET_TZ).date().isoformat()
    except ValueError:
        return None


def extras_fresh(old: dict, now: datetime) -> bool:
    ts = old.get("extras_asof")
    if not ts:
        return False
    try:
        return (now - datetime.fromisoformat(ts)).total_seconds() < EXTRAS_TTL
    except ValueError:
        return False


def _prefetch_ticker(sym: str, snapshots: dict, old_bars: dict, skip_extras: bool) -> dict:
    """阶段1(线程池并发):纯网络抓取,只读、建局部数据,不碰任何全局。
    抓 K线×3(+ 非skip 时日线/short/vol/news)+ 期权链;错误收进本票列表返回。"""
    errs, bar_entry = [], dict(old_bars)
    for key_name, mult, timespan, days, y_iv, y_pd, keep in INTRADAY_SPECS:
        bars, suf = None, key_name.split("_")[1]
        if KEY:
            try:
                bars = fetch_bars(sym, mult, timespan, days, keep); bar_entry[f"src_{suf}"] = "massive"
            except Exception as exc:  # noqa: BLE001
                errs.append(f"{sym} {key_name}(massive): {redact(exc)}")
        if not bars:
            try:
                bars = bars_yahoo(sym, y_iv, y_pd, keep); bar_entry[f"src_{suf}"] = "yahoo"
            except Exception as exc:  # noqa: BLE001
                errs.append(f"{sym} {key_name}(yahoo): {redact(exc)}")
        if bars:
            bar_entry[key_name] = bars

    bars_d = src_d = None
    extras = {}
    if not skip_extras:
        if KEY:
            try:
                bars_d = fetch_bars(sym, 1, "day", 183, 200); src_d = "massive"
            except Exception as exc:  # noqa: BLE001
                errs.append(f"{sym} bars_d(massive): {redact(exc)}")
        if not bars_d:
            try:
                bars_d = bars_yahoo(sym, "1d", "6mo", 200); src_d = "yahoo"
            except Exception as exc:  # noqa: BLE001
                errs.append(f"{sym} bars_d(yahoo): {redact(exc)}")
        if KEY:
            for fn, k, label in ((fetch_short, "short", "short interest"),
                                 (fetch_short_volume, "short_vol", "short volume"),
                                 (fetch_news, "news", "新闻(massive)")):
                try:
                    extras[k] = fn(sym)
                except Exception as exc:  # noqa: BLE001
                    errs.append(f"{sym} {label}: {redact(exc)}")

    spot = (snapshots.get(sym) or {}).get("price") \
        or (bar_entry.get("bars_1m") or bar_entry.get("bars_5m") or [[0] * 5])[-1][4] or None

    contracts, osrc = None, None
    if KEY:
        try:
            contracts = options_massive(sym, spot); osrc = "massive"
        except requests.HTTPError as exc:
            if not (exc.response is not None and exc.response.status_code in (401, 403)):
                errs.append(f"{sym} 期权(massive): {redact(exc)}")  # 401/403=无套餐,静默回退
        except Exception as exc:  # noqa: BLE001
            errs.append(f"{sym} 期权(massive): {redact(exc)}")
    if contracts is None:
        try:
            contracts = options_yahoo(sym); osrc = osrc or "yahoo"
        except Exception as exc:  # noqa: BLE001
            errs.append(f"{sym} 期权(yahoo): {redact(exc)}")

    return {"sym": sym, "bar_entry": bar_entry, "bars_d": bars_d, "src_d": src_d,
            "extras": extras, "spot": spot, "contracts": contracts,
            "options_source": osrc, "errors": errs}


def main(tickers: list | None = None, merge: bool = False) -> None:
    """tickers=None 抓全 watchlist(普通组=全量深度待遇);merge=True 增量合并。
    注:deep 字段暂不作门槛(含义待定),全量给 K线/期权/GEX/指标。"""
    from _cfg import load_tickers
    watchlist, _ = load_tickers()
    targets = [t for t in (tickers or watchlist) if t in watchlist] or watchlist
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat(timespec="seconds")

    prev = load_json(ROOT / "data" / "research.json", {}) if merge else {}
    out = {"updated_at": now_iso, "snapshots": {},
           "tickers": dict(prev.get("tickers") or {}),
           "errors": [], "options_source": prev.get("options_source")}
    gex_prev = load_json(ROOT / "data" / "gex.json", {}) if merge else {}
    gex_out = {"updated_at": now_iso,
               "tickers": dict(gex_prev.get("tickers") or {}), "errors": []}
    # 高频 K 线拆到独立文件(控制 research.json 体积/diff)
    bars_prev = load_json(ROOT / "data" / "bars_intraday.json", {}) if merge else {}
    bars_out = {"updated_at": now_iso,
                "tickers": dict(bars_prev.get("tickers") or {}), "errors": []}

    oi_path = ROOT / "data" / "oi_prev.json"
    oi_all = load_json(oi_path, {}).get("oi", {})
    oi_next: dict = {}

    # 快照采样版流量累积器(每轮更新,当日累计;隔日自动重置)
    flow_path = ROOT / "data" / "flow_accum.json"
    flow_acc = load_json(flow_path, {})
    # 逐笔精确层(top-N,贵,低频跑 FLOW_PRECISE=1;结果当日复用,每轮覆盖采样判向)
    flow_precise_path = ROOT / "data" / "flow_precise.json"
    flow_precise = load_json(flow_precise_path, {})
    if flow_precise.get("date") != now.date().isoformat():
        flow_precise = {"date": now.date().isoformat(), "net": {}}
    do_precise = os.environ.get("FLOW_PRECISE", "").lower() in ("1", "true")
    oiflow_today: dict = {}  # 本轮各票近价合约的 OI+主动净+gamma,供开/平仓四象限离线估算
    ivobs_today: dict = {}   # 零风险观测:近 30DTE 到期的 strike/delta/iv/mid,供离线看 25Δ 覆盖(可随时删)
    profile_today: dict = {}  # EOD GEX 形状快照(week/2wk/30d 各档 by_strike),按日期分区落 Parquet,供墙-引力研究

    # 全 watchlist 实时快照(1 次调用,批模式下也整表刷新)
    if KEY:
        try:
            out["snapshots"] = fetch_snapshots(watchlist)
        except Exception as exc:  # noqa: BLE001
            out["errors"].append(f"实时快照: {redact(exc)}")
    if merge and not out["snapshots"]:
        out["snapshots"] = prev.get("snapshots") or {}

    # ---- 阶段1:并发预取每票网络数据(K线/日线/extras/期权链),不碰全局 ----
    t_pf = time.time()
    prefetched = {}
    with ThreadPoolExecutor(max_workers=PREFETCH_WORKERS) as ex:
        futs = {ex.submit(_prefetch_ticker, sym, out["snapshots"],
                          (bars_prev.get("tickers") or {}).get(sym, {}) if merge else {},
                          extras_fresh((prev.get("tickers") or {}).get(sym, {}) if merge else {}, now)): sym
                for sym in targets}
        for fut in futs:
            sym = futs[fut]
            try:
                prefetched[sym] = fut.result()
            except Exception as exc:  # noqa: BLE001
                out["errors"].append(f"{sym} 预取: {redact(exc)}")
    print(f"阶段1 并发预取 {len(prefetched)}/{len(targets)} 票用时 {time.time() - t_pf:.0f}s")

    # ---- 阶段2:串行处理(改共享状态,CPU 为主),按 targets 顺序保证确定性 ----
    for sym in targets:
        r = prefetched.get(sym)
        if not r:
            continue
        out["errors"].extend(r["errors"])
        old = (prev.get("tickers") or {}).get(sym, {}) if merge else {}
        skip_extras = extras_fresh(old, now)
        bar_entry = r["bar_entry"]
        bars_out["tickers"][sym] = bar_entry
        entry = {"asof": now_iso}
        if r["bars_d"]:
            entry["bars_d"] = r["bars_d"]; entry["src_d"] = r["src_d"]
        entry["vwap"] = session_vwap(bar_entry.get("bars_1m") or [])

        # 低频层:skip 时沿用旧值,否则用阶段1 抓到的 extras
        if skip_extras:
            for k in EXTRAS_KEYS:
                if k in old:
                    entry[k] = old[k]
        else:
            entry.update(r["extras"])
            entry["extras_asof"] = now_iso

        # 技术指标:本地从 K 线算(零 API 成本)
        closes_m = [b[4] for b in bar_entry.get("bars_1m", [])]
        closes_d = [b[4] for b in entry.get("bars_d", [])]
        if closes_m or closes_d:
            entry["ind"] = {"rsi_m": rsi(closes_m), "rsi_d": rsi(closes_d),
                            "ema9_m": ema_last(closes_m, 9), "ema21_m": ema_last(closes_m, 21)}

        # 近期日均量(EWMA span=20),%ADV/maxpain 用它替代滞后 3 周的 short.avg_daily_volume
        entry["adv20"] = ewma_adv(entry.get("bars_d"), 20, now.date())

        if r["options_source"] == "massive":
            out["options_source"] = "massive"
        elif r["options_source"] and not out["options_source"]:
            out["options_source"] = r["options_source"]

        spot = r["spot"]
        contracts = r["contracts"]
        if contracts:
            entry["options"] = summarize_options(sym, contracts, spot, oi_all, oi_next)
            entry["options"]["contracts"] = len(contracts)
            obs = iv_obs_rows(sym, contracts, now.date())  # 观测(不入指标),含 Yahoo 源以便看缺口
            if obs:
                ivobs_today[sym] = obs
            # 批间 premium 增量(仅同一交易日内比较,premium 是当日累计值)
            old_opt = old.get("options") or {}
            if (merge and old_opt.get("call_premium") is not None
                    and et_day(old.get("asof")) == et_day(now_iso)):
                entry["options"]["prem_delta"] = {
                    "call": entry["options"]["call_premium"] - old_opt["call_premium"],
                    "put": entry["options"]["put_premium"] - old_opt["put_premium"],
                    "since": old.get("asof"),
                }
            gex = compute_gex(contracts, spot)
            if gex:
                # Real/flow 口径依赖 Massive 的 OCC ticker + NBBO;Yahoo 回退两者都没有,
                # 跳过整段(gex.flow 缺失 → 前端 flowMiss 显示 "Real N/A→Raw",而非假的 coverage=0)。
                if r["options_source"] == "massive":
                    # 流量版=快照采样(每轮,零额外 API,免 delta 污染);FLOW_PRECISE 时叠 top-N 逐笔精确层
                    update_flow_accum(contracts, flow_acc, now.date().isoformat(), spot, now.date())
                    if do_precise:
                        flow_precise["net"].update(compute_flow_precise(sym, spot, contracts, now.date(), out["errors"]))
                    flow = compute_gex_flow_sampled(sym, spot, contracts, flow_acc, now.date(),
                                                    precise=flow_precise.get("net"))
                    if flow:
                        gex["flow"] = flow
                    rows = oi_flow_rows(sym, contracts, flow_acc.get("c", {}), spot, now.date())
                    if rows:
                        oiflow_today[sym] = rows
                    # 每档净主动买卖(Lee-Ready buy−sell 按行权价聚合,calls+puts),供 Net Flow 梯
                    fc = flow_acc.get("c", {})
                    sflow: dict = {}
                    for c in contracts:
                        acc = fc.get(c.get("ticker"))
                        if acc:
                            sflow[c["strike"]] = sflow.get(c["strike"], 0.0) + (acc[1] - acc[2])
                    for row in (entry.get("options") or {}).get("by_strike") or []:
                        nf = sflow.get(row["strike"])
                        if nf:
                            row["netflow"] = round(nf, 1)
                gex_out["tickers"][sym] = gex
                prows = gex_profile_rows(gex)  # EOD 墙形状快照(nominal 恒有;real 仅 massive+单名股)
                if prows:
                    fnb = (gex.get("buckets", {}).get("all") or {})
                    ffb = ((gex.get("flow") or {}).get("buckets", {}).get("all") or {})
                    profile_today[sym] = {"spot": gex.get("spot"),
                                          "flip_nom": fnb.get("flip"), "flip_real": ffb.get("flip"),
                                          "rows": prows}

        out["tickers"][sym] = entry
        done = [k for k in ("bars_1m", "bars_5m", "bars_15m") if bar_entry.get(k)] \
            + [k for k in ("ind", "short", "short_vol", "news", "options") if entry.get(k)]
        print(f"✓ {sym}: {'/'.join(done) or '无数据'}{'(低频层沿用)' if skip_extras else ''}")

    if not KEY:
        out["errors"].append("未设置 MASSIVE_API_KEY:快照/指标/short 未抓取,K线与期权走雅虎回退")

    # 先算派生标量(skew/term/VRP + 相对 QQQ),再统一算自身历史百分位
    daily_path = ROOT / "data" / "gex_daily.json"
    daily = load_json(daily_path, {})
    today_str = now.date().isoformat()
    # 基准一律 QQQ(其期权本轮/上轮已采,合并在 out["tickers"] 中)
    qopt = (out["tickers"].get("QQQ") or {}).get("options") or {}
    qiv = qopt.get("atm_iv")
    qrr = (qopt.get("iv_skew") or {}).get("rr")
    for sym in targets:
        opt = (out["tickers"].get(sym) or {}).get("options")
        if not opt:
            continue
        # 派生标量:供百分位与前端展示
        opt["skew_rr"] = (opt.get("iv_skew") or {}).get("rr")
        be = opt.get("by_expiry") or []
        if len(be) >= 2 and be[0].get("atm_iv") and be[-1].get("atm_iv"):
            opt["iv_term"] = round(be[0]["atm_iv"] - be[-1]["atm_iv"], 4)  # >0 = backwardation
        rv = realized_vol((out["tickers"].get(sym) or {}).get("bars_d"), 20)
        if opt.get("atm_iv") is not None and rv is not None:
            opt["vrp"] = round(opt["atm_iv"] - rv, 4)
            opt["rv20"] = round(rv, 4)
        # Max Pain 可信度分(0-100):需 GEX(flip/net)+ ADV + RV,故在此后处理算(见 maxpain_pin_score)
        gx = gex_out["tickers"].get(sym) or {}
        entry_sym = out["tickers"].get(sym) or {}
        adv = entry_sym.get("adv20") or ((entry_sym.get("short") or {}).get("avg_daily_volume"))  # 优先 EWMA,回退旧值
        mp_dte = (date.fromisoformat(opt["max_pain_exp"]) - now.date()).days if opt.get("max_pain_exp") else None
        opt["maxpain_pin"] = maxpain_pin_score(
            gx.get("spot"), gx.get("flip"), gx.get("net_gex"),
            opt.get("max_pain"), opt.get("atm_iv"), mp_dte, rv, adv)
        # 相对 QQQ(基准自身不与自身比)
        if sym != "QQQ":
            if opt.get("atm_iv") and qiv:
                opt["iv_vs_qqq"] = round(opt["atm_iv"] / qiv, 2)
            if opt.get("skew_rr") is not None and qrr is not None:
                opt["skew_vs_qqq"] = round(opt["skew_rr"] - qrr, 4)
        # 自身历史百分位(样本 <10 天返回 None)
        for key in ("pcr_vol", "pcr_oi", "atm_iv", "skew_rr", "iv_term", "vrp", "iv_vs_qqq"):
            hist = [daily[d][sym][key] for d in daily
                    if sym in daily[d] and daily[d][sym].get(key) is not None and d != today_str][-60:]
            opt[f"{key}_pct"] = pct_rank(hist, opt.get(key))

    # 财报临近(IV crush 风险):跨读 market.json 的财报日历,算到下一次财报的天数
    mkt = load_json(ROOT / "data" / "market.json", {})
    ecal = {}
    for e in (mkt.get("earnings_calendar") or []):
        if e.get("symbol") and e.get("date") and e["date"] >= today_str:
            ecal.setdefault(e["symbol"], e["date"])  # 日历已按日期升序,取最近的未来一场
    for sym in targets:
        entry = out["tickers"].get(sym)
        if entry and ecal.get(sym):
            entry["earnings_date"] = ecal[sym]
            entry["earnings_days"] = (date.fromisoformat(ecal[sym]) - now.date()).days

    (ROOT / "data" / "research.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    # 高频 K 线独立文件,紧凑写(无缩进)以压小体积/diff
    (ROOT / "data" / "bars_intraday.json").write_text(
        json.dumps(bars_out, ensure_ascii=False, separators=(",", ":")))
    if oi_next:
        oi_all.update(oi_next)  # 只更新本批标的的合约,保留其他标的的存档
        oi_path.write_text(json.dumps(
            {"date": now.date().isoformat(), "oi": oi_all}, ensure_ascii=False))
    if flow_acc.get("c"):  # 快照采样流量累积器,紧凑写
        flow_path.write_text(json.dumps(flow_acc, ensure_ascii=False, separators=(",", ":")))
    if flow_precise.get("net"):  # 逐笔精确层(当日复用)
        flow_precise_path.write_text(json.dumps(flow_precise, ensure_ascii=False, separators=(",", ":")))
    if oiflow_today:  # 每日 per-contract OI+主动净+gamma(开/平仓四象限的离线原料),留 45 天
        oif_path = ROOT / "data" / "oi_flow_daily.json"
        oif = load_json(oif_path, {})
        days = oif.get("days") or {}
        days.setdefault(now.date().isoformat(), {}).update(oiflow_today)  # 当日最后一轮=全天累计主动流
        for d in sorted(days)[:-45]:
            del days[d]
        oif_path.write_text(json.dumps({"days": days}, ensure_ascii=False, separators=(",", ":")))

    if ivobs_today:  # 零风险观测快照(最新一轮覆盖即可;不做保留,分析完可删本块+文件)
        (ROOT / "data" / "iv_obs.json").write_text(
            json.dumps({"updated_at": now_iso, "tickers": ivobs_today},
                       ensure_ascii=False, separators=(",", ":")))

    if profile_today:  # EOD GEX 形状 → 每日一个 Parquet(按日期分区,只写当天;留 250 天),供墙-引力研究
        try:
            import pyarrow as pa, pyarrow.parquet as pq
            cols = {k: [] for k in ("sym", "bucket", "strike", "net_nom", "net_real", "spot", "flip_nom", "flip_real")}
            for sym, p in profile_today.items():
                for (b, k, nn, nr) in p["rows"]:
                    cols["sym"].append(sym); cols["bucket"].append(b); cols["strike"].append(k)
                    cols["net_nom"].append(nn); cols["net_real"].append(nr)
                    cols["spot"].append(p["spot"]); cols["flip_nom"].append(p["flip_nom"]); cols["flip_real"].append(p["flip_real"])
            prof_dir = ROOT / "data" / "gex_profile"
            prof_dir.mkdir(exist_ok=True)
            pq.write_table(pa.table(cols), prof_dir / f"{now.date().isoformat()}.parquet", compression="zstd")
            for f in sorted(prof_dir.glob("*.parquet"))[:-250]:  # 留 250 天
                f.unlink()
        except ImportError:
            out["errors"].append("pyarrow 未安装:跳过 gex_profile Parquet sink(pip install pyarrow)")

    # 指数主池 GEX:抓 I:{index} 真·指数 gamma,合并进对应 ETF(÷价格比落 ETF 轴)→ ETF 的梯/图显示真结构。
    # 失败不影响其余。
    if KEY:
        for isym, etf in (("SPX", "SPY"), ("NDX", "QQQ")):
            try:
                idx = fetch_index_gex(isym, out["errors"])
                if idx:
                    gex_out["tickers"][isym] = idx   # 保留原始主池(参考/调试)
                    e = gex_out["tickers"].get(etf)
                    if e and e.get("spot") and idx.get("spot"):
                        merge_index_into_etf(e, idx, idx["spot"] / e["spot"])
            except Exception as exc:  # noqa: BLE001
                out["errors"].append(f"{isym} 指数GEX: {redact(exc)}")

    # GEX 快照 + 当日盘中净 GEX 序列(隔日清空)
    (ROOT / "data" / "gex.json").write_text(json.dumps(gex_out, ensure_ascii=False, indent=1))
    hist_path = ROOT / "data" / "gex_history.json"
    hist = load_json(hist_path, {"date": "", "points": []})
    today_str = now.date().isoformat()
    if hist.get("date") != today_str:
        hist = {"date": today_str, "points": []}
    for sym in targets:
        g = gex_out["tickers"].get(sym)
        if g:
            pt = {"t": now_iso, "sym": sym,
                  "net": g["net_gex"], "spot": g["spot"],
                  "nets": {k: v["net_gex"] for k, v in g.get("buckets", {}).items()}}
            f = g.get("flow")  # Real(sampled)口径的 per-bucket net,供趋势副线跟随口径
            if f:
                pt["fnet"] = f["net_gex"]
                pt["fnets"] = {k: v["net_gex"] for k, v in f.get("buckets", {}).items()}
            hist["points"].append(pt)
    hist_path.write_text(json.dumps(hist, ensure_ascii=False, indent=1))

    # 前向记录器(flow-GEX 预测力 pilot):每轮每票一条,**跨天累积不清零**,留 60 天。
    # 记真实 flow-GEX 净值(带 gamma×OI,采样+精确)+ 名义 net + OI + spot;
    # 前向收益后续由 spot 序列推,OI 日变化由 co/po 日间差推(区分开/平仓)。见 scripts/eval_flow_history.py。
    fh_path = ROOT / "data" / "flow_history.json"
    fh = load_json(fh_path, {"points": []})
    for sym in targets:
        g = gex_out["tickers"].get(sym) or {}
        opt = (out["tickers"].get(sym) or {}).get("options") or {}
        spot = g.get("spot") or (out["snapshots"].get(sym) or {}).get("price")
        if spot is None:
            continue
        fl = g.get("flow") or {}
        fh["points"].append({
            "t": now_iso, "s": sym, "p": round(spot, 4),
            "fn": round(fl["net_gex"]) if fl.get("net_gex") is not None else None,   # flow-GEX 净(带 gamma)
            "cov": fl.get("coverage"), "meth": fl.get("method"),
            "nn": round(g["net_gex"]) if g.get("net_gex") is not None else None,      # 名义 net(对照)
            "co": opt.get("call_oi"), "po": opt.get("put_oi"),                        # OI(日间差=开/平仓)
        })
    cutoff = (now.date() - timedelta(days=60)).isoformat()
    fh["points"] = [p for p in fh["points"] if (p.get("t") or "")[:10] >= cutoff]
    fh_path.write_text(json.dumps(fh, ensure_ascii=False, separators=(",", ":")))

    # 策略页 producer:SPX SqueezeMetrics → 研究结论(净GEX→次日波动)+ DIX 真回测 → data/strategy_bt.json。
    # 每天最多算一次(内部按 asof 日期 gate);拉外网/失败绝不影响采集。单名股回测走 CLI: strategy_run.py。
    try:
        import strategy_spx
        strategy_spx.main()
    except Exception as exc:  # noqa: BLE001
        out["errors"].append(f"strategy_bt: {redact(exc)}")

    # 累积日志(供回测 + PCR 历史百分位):每 (日期,标的) 一条,当日多次运行更新为最后读数;留 250 天
    day = daily.setdefault(today_str, {})
    for sym in targets:
        g = gex_out["tickers"].get(sym)
        if not g:
            continue
        fl = g.get("flow") or {}
        opt = (out["tickers"].get(sym) or {}).get("options") or {}
        day[sym] = {"t": now_iso, "spot": g["spot"],
                    "flip_nom": g["flip"], "net_nom": g["net_gex"],
                    "flip_flow": fl.get("flip"), "net_flow": fl.get("net_gex"),
                    "coverage": fl.get("coverage"), "ambiguity": fl.get("ambiguity"),
                    "pcr_vol": opt.get("pcr_vol"), "pcr_oi": opt.get("pcr_oi"), "atm_iv": opt.get("atm_iv"),
                    "skew_rr": opt.get("skew_rr"), "iv_term": opt.get("iv_term"),
                    "vrp": opt.get("vrp"), "iv_vs_qqq": opt.get("iv_vs_qqq"),
                    "max_pain": opt.get("max_pain"), "maxpain_pin": opt.get("maxpain_pin")}
    for k in sorted(daily)[:-250]:  # 只留最近 250 天
        del daily[k]
    daily_path.write_text(json.dumps(daily, ensure_ascii=False, indent=1))

    print(f"已写入 research/bars_intraday/gex/gex_history/gex_daily(期权源: {out['options_source']}, "
          f"本批 {len(targets)} 只, 错误 {len(out['errors'])} 条)")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--tickers", help="逗号分隔的标的,默认全 watchlist")
    ap.add_argument("--merge", action="store_true", help="增量合并进现有 JSON(滚动采集批模式)")
    args = ap.parse_args()
    main([s.strip().upper() for s in args.tickers.split(",") if s.strip()] if args.tickers else None,
         args.merge)
