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
import json
import os
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
MAX_DTE = 45
MAX_EXPIRATIONS = 6
BAR_KEEP = 800  # 每个粒度最多保留的 bar 数


def redact(exc) -> str:
    """报错里可能带完整 URL(含 apiKey 查询参数),公开仓库的日志必须脱敏。"""
    return str(exc).replace(KEY, "***") if KEY else str(exc)


def mget(path: str, **params):
    url = path if path.startswith("http") else f"{BASE}{path}"
    if KEY:
        params.setdefault("apiKey", KEY)  # 兼容只认查询参数的网关;官方两种都支持
    # 期权端点(链快照 + 单合约逐笔成交)共用 50/分钟额度,单独降速
    is_opt = "/v3/snapshot/options/" in url or "/v3/trades/O" in url or "/v3/quotes/O" in url
    sleep = OPT_SLEEP if is_opt else SLEEP
    resp = None
    for _ in range(3):
        resp = requests.get(url, params=params, headers=HEADERS, timeout=30)
        if resp.status_code == 429:
            time.sleep(62)
            continue
        resp.raise_for_status()
        time.sleep(sleep)
        return resp.json()
    resp.raise_for_status()


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


def fetch_bars(sym: str, mult: int, timespan: str, days: int) -> list:
    """K 线 [t(ms), o, h, l, c, v, vw]。"""
    to = date.today()
    frm = to - timedelta(days=days)
    data = mget(f"/v2/aggs/ticker/{sym}/range/{mult}/{timespan}/{frm}/{to}",
                adjusted="true", sort="asc", limit=50000)
    return [[r["t"], r["o"], r["h"], r["l"], r["c"], r["v"], r.get("vw")]
            for r in (data.get("results") or [])][-BAR_KEEP:]


def bars_yahoo(sym: str, interval: str, period: str) -> list:
    """雅虎 K 线回退(免费,盘中约 15 分钟内延迟)。"""
    import yfinance as yf
    df = yf.Ticker(sym).history(period=period, interval=interval)
    return [[int(ts.timestamp() * 1000),
             round(float(r["Open"]), 4), round(float(r["High"]), 4),
             round(float(r["Low"]), 4), round(float(r["Close"]), 4),
             int(r["Volume"]), None]
            for ts, r in df.iterrows()][-BAR_KEEP:]


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


# GEX 按到期分桶(累计口径,0dte ⊂ week ⊂ 2wk ⊂ all),前端可切,默认 0DTE
GEX_BUCKETS = [("0dte", 0), ("week", 7), ("2wk", 14), ("all", MAX_DTE)]


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


def fetch_option_trades(contract_ticker: str) -> list:
    """单合约当日逐笔成交(时间升序),返回 [(price, size, conditions)]。"""
    out, url, pages = [], f"/v3/trades/{contract_ticker}?limit=50000&order=asc&sort=timestamp", 0
    while url and pages < 3:
        d = mget(url)
        for t in d.get("results") or []:
            out.append((t.get("price"), t.get("size") or 0, t.get("conditions") or []))
        url = rebase_url(d.get("next_url"))
        pages += 1
    return out


def classify_net_flow(trades: list) -> tuple[float, float]:
    """conditions 过滤 + 零档 tick rule + size 加权 → (净方向=买size−卖size, 已分类size)。"""
    buy = sell = 0.0
    prev = None
    last_dir = 0
    for price, size, conds in trades:
        if price is None or not size or any(c in FLOW_BAD_CONDITIONS for c in conds):
            continue
        if prev is None:
            prev = price
            continue
        d = 1 if price > prev else -1 if price < prev else last_dir  # 零档沿用上一方向
        prev = price
        if d > 0:
            buy += size; last_dir = 1
        elif d < 0:
            sell += size; last_dir = -1
    return buy - sell, buy + sell


def compute_gex_flow(sym: str, spot: float, contracts: list, errors: list) -> dict | None:
    """流量分类 GEX:±15%/≤14天里 top-N 活跃合约按真实买卖方向定 dealer 符号,其余用名义符号。"""
    if not spot or sym in FLOW_SKIP:
        return None
    today = date.today()
    lo, hi = spot * (1 - FLOW_STRIKE_BAND), spot * (1 + FLOW_STRIKE_BAND)
    cand = [c for c in contracts if c.get("ticker") and c["vol"] and lo <= c["strike"] <= hi
            and 0 <= (date.fromisoformat(c["exp"]) - today).days <= FLOW_MAX_DTE]
    ranked = sorted(cand, key=lambda c: -c["vol"])[:FLOW_TOPN]
    flow_sign = {}  # ticker -> dealer 符号(客户净多→dealer空→-1)
    for c in ranked:
        try:
            net, sz = classify_net_flow(fetch_option_trades(c["ticker"]))
            if sz > 0 and net != 0:
                flow_sign[c["ticker"]] = -1 if net > 0 else 1
        except Exception as exc:  # noqa: BLE001 单合约失败不影响整体
            errors.append(f"{sym} 流量 {c['ticker']}: {redact(exc)}")
    if not flow_sign:
        return None  # 一个都没分类到就不出流量版,避免和名义版完全一样
    enriched = []
    for c in contracts:
        go = _contract_gamma_oi(c, spot, today)
        if go is None:
            continue
        sign = flow_sign.get(c.get("ticker"), 1 if c["type"] == "call" else -1)  # 未分类→名义
        enriched.append(((date.fromisoformat(c["exp"]) - today).days, c["strike"], sign * go))
    out = _bucketize(enriched, spot)
    if out:
        out["classified"] = len(flow_sign)  # 实际分类到的合约数,前端可显示
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
            })
        url = rebase_url(data.get("next_url"))
    return contracts


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
                contracts.append({"type": typ, "strike": float(row.strike), "exp": d,
                                  "iv": iv, "oi": oi, "vol": vol, "price": price})
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

    oi_path = ROOT / "data" / "oi_prev.json"
    oi_all = load_json(oi_path, {}).get("oi", {})
    oi_next: dict = {}

    # 全 watchlist 实时快照(1 次调用,批模式下也整表刷新)
    if KEY:
        try:
            out["snapshots"] = fetch_snapshots(watchlist)
        except Exception as exc:  # noqa: BLE001
            out["errors"].append(f"实时快照: {redact(exc)}")
    if merge and not out["snapshots"]:
        out["snapshots"] = prev.get("snapshots") or {}

    use_massive_options = bool(KEY)
    for sym in targets:
        old = (prev.get("tickers") or {}).get(sym, {}) if merge else {}
        entry = {"asof": now_iso}
        skip_extras = extras_fresh(old, now)

        # K线: 1分钟/5分钟每批都刷;日线属于低频层
        specs = [("bars_1m", 1, "minute", 2, "1m", "2d"),
                 ("bars_5m", 5, "minute", 7, "5m", "5d")]
        if not skip_extras:
            specs.append(("bars_d", 1, "day", 183, "1d", "6mo"))
        for key_name, mult, timespan, days, y_iv, y_pd in specs:
            bars = None
            if KEY:
                try:
                    bars = fetch_bars(sym, mult, timespan, days)
                    entry[f"src_{key_name.split('_')[1]}"] = "massive"
                except Exception as exc:  # noqa: BLE001
                    out["errors"].append(f"{sym} {key_name}(massive): {redact(exc)}")
            if not bars:
                try:
                    bars = bars_yahoo(sym, y_iv, y_pd)
                    entry[f"src_{key_name.split('_')[1]}"] = "yahoo"
                except Exception as exc:  # noqa: BLE001
                    out["errors"].append(f"{sym} {key_name}(yahoo): {redact(exc)}")
            if bars:
                entry[key_name] = bars
        entry["vwap"] = session_vwap(entry.get("bars_1m") or [])

        # 低频层: 指标/short/新闻/日线,每 EXTRAS_TTL 秒刷一次,批模式下沿用旧值
        if skip_extras:
            for k in EXTRAS_KEYS:
                if k in old:
                    entry[k] = old[k]
        elif KEY:
            try:
                entry["short"] = fetch_short(sym)
            except Exception as exc:  # noqa: BLE001
                out["errors"].append(f"{sym} short interest: {redact(exc)}")
            try:
                entry["short_vol"] = fetch_short_volume(sym)
            except Exception as exc:  # noqa: BLE001
                out["errors"].append(f"{sym} short volume: {redact(exc)}")
            try:
                entry["news"] = fetch_news(sym)
            except Exception as exc:  # noqa: BLE001
                out["errors"].append(f"{sym} 新闻(massive): {redact(exc)}")
            entry["extras_asof"] = now_iso

        # 技术指标:本地从 K 线算(零 API 成本),每批刷新
        closes_m = [b[4] for b in entry.get("bars_1m", [])]
        closes_d = [b[4] for b in entry.get("bars_d", [])]
        if closes_m or closes_d:
            entry["ind"] = {"rsi_m": rsi(closes_m), "rsi_d": rsi(closes_d),
                            "ema9_m": ema_last(closes_m, 9), "ema21_m": ema_last(closes_m, 21)}

        spot = (out["snapshots"].get(sym) or {}).get("price") \
            or (entry.get("bars_1m") or entry.get("bars_5m") or [[0] * 5])[-1][4] or None

        # 期权(每批都刷,GEX 由链上 gamma 一并算出)
        contracts = None
        if use_massive_options:
            try:
                contracts = options_massive(sym, spot)
                out["options_source"] = "massive"
            except requests.HTTPError as exc:
                if exc.response is not None and exc.response.status_code in (401, 403):
                    use_massive_options = False  # 没开 Options 套餐,后续都走雅虎
                else:
                    out["errors"].append(f"{sym} 期权(massive): {redact(exc)}")
        if contracts is None:
            try:
                contracts = options_yahoo(sym)
                out["options_source"] = out["options_source"] or "yahoo"
            except Exception as exc:  # noqa: BLE001
                out["errors"].append(f"{sym} 期权(yahoo): {redact(exc)}")
        if contracts:
            entry["options"] = summarize_options(sym, contracts, spot, oi_all, oi_next)
            entry["options"]["contracts"] = len(contracts)
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
                # 流量分类版:重(每合约一次 trades 调用),只在低频层跑,其余批次沿用上次
                if skip_extras:
                    prevf = ((gex_prev.get("tickers") or {}).get(sym) or {}).get("flow")
                    if prevf:
                        gex["flow"] = prevf
                else:
                    flow = compute_gex_flow(sym, spot, contracts, out["errors"])
                    if flow:
                        gex["flow"] = flow
                gex_out["tickers"][sym] = gex

        out["tickers"][sym] = entry
        done = [k for k in ("bars_1m", "bars_5m", "ind", "short", "short_vol", "news", "options") if entry.get(k)]
        print(f"✓ {sym}: {'/'.join(done) or '无数据'}{'(低频层沿用)' if skip_extras else ''}")

    if not KEY:
        out["errors"].append("未设置 MASSIVE_API_KEY:快照/指标/short 未抓取,K线与期权走雅虎回退")

    (ROOT / "data" / "research.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    if oi_next:
        oi_all.update(oi_next)  # 只更新本批标的的合约,保留其他标的的存档
        oi_path.write_text(json.dumps(
            {"date": now.date().isoformat(), "oi": oi_all}, ensure_ascii=False))

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
            hist["points"].append({"t": now_iso, "sym": sym,
                                   "net": g["net_gex"], "spot": g["spot"],
                                   "nets": {k: v["net_gex"] for k, v in g.get("buckets", {}).items()}})
    hist_path.write_text(json.dumps(hist, ensure_ascii=False, indent=1))
    print(f"已写入 research/gex/gex_history(期权源: {out['options_source']}, "
          f"本批 {len(targets)} 只, 错误 {len(out['errors'])} 条)")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--tickers", help="逗号分隔的标的,默认全 watchlist")
    ap.add_argument("--merge", action="store_true", help="增量合并进现有 JSON(滚动采集批模式)")
    args = ap.parse_args()
    main([s.strip().upper() for s in args.tickers.split(",") if s.strip()] if args.tickers else None,
         args.merge)
