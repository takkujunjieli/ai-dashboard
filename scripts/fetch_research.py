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

ROOT = Path(__file__).resolve().parent.parent
KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
HEADERS = {"Authorization": f"Bearer {KEY}"}
SLEEP = float(os.environ.get("MASSIVE_SLEEP", "0.2"))  # Advanced 无限速,留一点礼貌间隔
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
    resp = None
    for _ in range(3):
        resp = requests.get(url, params=params, headers=HEADERS, timeout=30)
        if resp.status_code == 429:
            time.sleep(62)
            continue
        resp.raise_for_status()
        time.sleep(SLEEP)
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


def latest_indicator(sym: str, kind: str, timespan: str, window: int):
    """RSI/EMA 等指标的最新值(官方 indicators 端点)。"""
    data = mget(f"/v1/indicators/{kind}/{sym}", timespan=timespan, window=window,
                **{"series_type": "close", "order": "desc", "limit": 1})
    vals = ((data.get("results") or {}).get("values")) or []
    return round(vals[0]["value"], 2) if vals else None


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

def rebase_url(url: str | None) -> str | None:
    """分页 next_url 可能指向官方域名,重写到配置的基址(自定义网关场景)。"""
    if not url:
        return None
    from urllib.parse import urlparse
    p = urlparse(url)
    return f"{BASE}{p.path}" + (f"?{p.query}" if p.query else "")


def options_massive(sym: str) -> list:
    contracts, url, today = [], f"/v3/snapshot/options/{sym}?limit=250", date.today()
    while url:
        data = mget(url)
        for o in data.get("results") or []:
            det = o.get("details") or {}
            exp = det.get("expiration_date")
            if not exp or not 0 <= (date.fromisoformat(exp) - today).days <= MAX_DTE:
                continue
            day = o.get("day") or {}
            contracts.append({
                "type": det.get("contract_type"),
                "strike": det.get("strike_price"),
                "exp": exp,
                "iv": o.get("implied_volatility"),
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

def main() -> None:
    research = json.loads((ROOT / "config" / "ticker_sets.json").read_text())["research"]
    watchlist = yaml.safe_load((ROOT / "config" / "watchlist.yml").read_text())["tickers"]
    now = datetime.now(timezone.utc)
    out = {"updated_at": now.isoformat(timespec="seconds"),
           "snapshots": {}, "tickers": {}, "errors": [], "options_source": None}

    prev_path = ROOT / "data" / "oi_prev.json"
    oi_prev, oi_next = {}, {}
    if prev_path.exists():
        try:
            oi_prev = json.loads(prev_path.read_text()).get("oi", {})
        except json.JSONDecodeError:
            pass

    # 全 watchlist 实时快照(1 次调用)
    if KEY:
        try:
            out["snapshots"] = fetch_snapshots(watchlist)
        except Exception as exc:  # noqa: BLE001
            out["errors"].append(f"实时快照: {redact(exc)}")

    use_massive_options = bool(KEY)
    for sym in research:
        entry = {}
        # K线: 1分钟(当日+昨日)、5分钟(5天)、日线(6个月),Massive 优先、雅虎兜底
        for key_name, mult, timespan, days, y_iv, y_pd in (
                ("bars_1m", 1, "minute", 2, "1m", "2d"),
                ("bars_5m", 5, "minute", 7, "5m", "5d"),
                ("bars_d", 1, "day", 183, "1d", "6mo")):
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

        # 技术指标(需要 Massive)
        if KEY:
            ind = {}
            for name, kind, ts, win in (("rsi_d", "rsi", "day", 14),
                                        ("rsi_m", "rsi", "minute", 14),
                                        ("ema9_m", "ema", "minute", 9),
                                        ("ema21_m", "ema", "minute", 21)):
                try:
                    ind[name] = latest_indicator(sym, kind, ts, win)
                except Exception as exc:  # noqa: BLE001
                    out["errors"].append(f"{sym} 指标{name}: {redact(exc)}")
            entry["ind"] = ind

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

        # 期权
        contracts = None
        if use_massive_options:
            try:
                contracts = options_massive(sym)
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
            spot = (out["snapshots"].get(sym) or {}).get("price") \
                or (entry.get("bars_1m") or entry.get("bars_5m") or [[0] * 5])[-1][4] or None
            entry["options"] = summarize_options(sym, contracts, spot, oi_prev, oi_next)
            entry["options"]["contracts"] = len(contracts)

        out["tickers"][sym] = entry
        done = [k for k in ("bars_1m", "bars_5m", "ind", "short", "short_vol", "news", "options") if entry.get(k)]
        print(f"✓ {sym}: {'/'.join(done) or '无数据'}")

    if not KEY:
        out["errors"].append("未设置 MASSIVE_API_KEY:快照/指标/short 未抓取,K线与期权走雅虎回退")

    (ROOT / "data" / "research.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    if oi_next:
        prev_path.write_text(json.dumps(
            {"date": now.date().isoformat(), "oi": oi_next}, ensure_ascii=False))
    print(f"已写入 data/research.json(期权源: {out['options_source']}, 错误 {len(out['errors'])} 条)")


if __name__ == "__main__":
    main()
