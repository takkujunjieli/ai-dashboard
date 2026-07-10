#!/usr/bin/env python3
"""短线研究数据:分钟 K 线(OHLCV)、Short Interest、期权链指标(C/P premium、成交量、OI 变化)。

数据源:
  股票(K线/short interest) — Massive API(https://massive.com,原 Polygon.io),
    需要 MASSIVE_API_KEY;免费版限速 5 次/分钟,分钟线为盘后数据,
    Stocks Starter 及以上为盘中 15 分钟延迟。
  期权链 — 优先 Massive(/v3/snapshot/options 需 Options Starter 付费档),
    未配置或无权限时自动回退雅虎期权链(免费,15 分钟延迟)。

OI 变化:每次运行把各合约 OI 存入 data/oi_prev.json,
下次运行与上一个交易日的存档对比,得到按行权价聚合的增减。

输出: data/research.json
"""
import json
import os
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
HEADERS = {"Authorization": f"Bearer {KEY}"}
RATE_SLEEP = 12.5     # 免费版 5 次/分钟
MAX_DTE = 45          # 期权只统计 45 天内到期
MAX_EXPIRATIONS = 5
BAR_DAYS = 7          # K线取最近 7 个自然日(前端展示最近 2 个交易日)


def mget(path: str, **params):
    """Massive GET,带限速与 429 重试。"""
    url = path if path.startswith("http") else f"{BASE}{path}"
    resp = None
    for _ in range(3):
        resp = requests.get(url, params=params, headers=HEADERS, timeout=30)
        if resp.status_code == 429:
            time.sleep(65)
            continue
        resp.raise_for_status()
        time.sleep(RATE_SLEEP)
        return resp.json()
    resp.raise_for_status()


def fetch_bars(sym: str) -> list:
    """Massive 5 分钟 K 线,[t(ms), o, h, l, c, v] 压缩数组。免费版为盘后数据。"""
    to = date.today()
    frm = to - timedelta(days=BAR_DAYS)
    data = mget(f"/v2/aggs/ticker/{sym}/range/5/minute/{frm}/{to}",
                adjusted="true", sort="asc", limit=5000)
    return [[r["t"], r["o"], r["h"], r["l"], r["c"], r["v"]]
            for r in (data.get("results") or [])][-800:]


def bars_yahoo(sym: str) -> list:
    """雅虎 5 分钟 K 线(免费,盘中约 15 分钟内延迟),结构同上。"""
    import yfinance as yf
    df = yf.Ticker(sym).history(period="5d", interval="5m")
    return [[int(ts.timestamp() * 1000),
             round(float(r["Open"]), 4), round(float(r["High"]), 4),
             round(float(r["Low"]), 4), round(float(r["Close"]), 4), int(r["Volume"])]
            for ts, r in df.iterrows()][-800:]


def fetch_short(sym: str) -> dict:
    data = mget("/stocks/v1/short-interest", ticker=sym, limit=1,
                sort="settlement_date.desc")
    rows = data.get("results") or []
    if not rows:
        raise ValueError("没有 short interest 数据")
    r = rows[0]
    return {
        "short_interest": r.get("short_interest"),
        "days_to_cover": r.get("days_to_cover"),
        "avg_daily_volume": r.get("avg_daily_volume"),
        "settlement_date": r.get("settlement_date"),
    }


def options_massive(sym: str) -> list:
    """Massive 期权链快照 → 统一合约结构。需要 Options Starter 及以上。"""
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
        url = data.get("next_url")
    return contracts


def options_yahoo(sym: str) -> list:
    """雅虎期权链回退(免费)。premium 用最新成交价近似。"""
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


def summarize_options(sym: str, contracts: list, spot: float | None,
                      oi_prev: dict, oi_next: dict) -> dict:
    s = {"call_premium": 0.0, "put_premium": 0.0, "call_vol": 0, "put_vol": 0,
         "call_oi": 0, "put_oi": 0}
    ivs = []
    for c in contracts:
        side = "call" if c["type"] == "call" else "put"
        s[f"{side}_premium"] += c["vol"] * c["price"] * 100
        s[f"{side}_vol"] += c["vol"]
        s[f"{side}_oi"] += c["oi"]
        # ATM IV: 最近到期日、现价 ±3% 内的合约
        if spot and c["iv"] and abs(c["strike"] - spot) / spot <= 0.03:
            ivs.append((c["exp"], c["iv"]))
        oi_next[f"{sym}|{c['exp']}|{c['strike']}|{side}"] = c["oi"]
    if ivs:
        nearest = min(e for e, _ in ivs)
        vals = [v for e, v in ivs if e == nearest]
        s["atm_iv"] = sum(vals) / len(vals)
    s["pcr_vol"] = round(s["put_vol"] / s["call_vol"], 2) if s["call_vol"] else None
    s["pcr_oi"] = round(s["put_oi"] / s["call_oi"], 2) if s["call_oi"] else None

    # OI 变化:与上一存档对比,按 行权价×方向 聚合,取变动最大的 10 条
    changes = {}
    for c in contracts:
        side = "call" if c["type"] == "call" else "put"
        key = f"{sym}|{c['exp']}|{c['strike']}|{side}"
        prev = oi_prev.get(key)
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


def main() -> None:
    cfg = json.loads((ROOT / "config" / "ticker_sets.json").read_text())
    tickers = cfg["research"]
    now = datetime.now(timezone.utc)
    out = {"updated_at": now.isoformat(timespec="seconds"),
           "tickers": {}, "errors": [], "options_source": None}

    # 上一交易日的 OI 存档
    prev_path = ROOT / "data" / "oi_prev.json"
    oi_prev, oi_next = {}, {}
    if prev_path.exists():
        try:
            oi_prev = json.loads(prev_path.read_text()).get("oi", {})
        except json.JSONDecodeError:
            pass

    use_massive_options = bool(KEY)
    for sym in tickers:
        entry = {}
        # --- K线: Massive(免费版盘后) 和 雅虎(盘中) 都取,谁新用谁 ---
        bars_m = bars_y = None
        if KEY:
            try:
                bars_m = fetch_bars(sym)
            except Exception as exc:  # noqa: BLE001
                out["errors"].append(f"{sym} K线(massive): {exc}")
        try:
            bars_y = bars_yahoo(sym)
        except Exception as exc:  # noqa: BLE001
            out["errors"].append(f"{sym} K线(yahoo): {exc}")
        last_t = lambda b: b[-1][0] if b else 0  # noqa: E731
        if bars_m or bars_y:
            use_m = last_t(bars_m) >= last_t(bars_y)
            entry["bars"] = bars_m if use_m else bars_y
            entry["bars_source"] = "massive" if use_m else "yahoo"
        # --- short interest(需要 Massive key) ---
        if KEY:
            try:
                entry["short"] = fetch_short(sym)
            except Exception as exc:  # noqa: BLE001
                out["errors"].append(f"{sym} short interest: {exc}")
        # --- 期权: Massive 优先,无权限自动回退雅虎 ---
        contracts = None
        if use_massive_options:
            try:
                contracts = options_massive(sym)
                out["options_source"] = "massive"
            except requests.HTTPError as exc:
                if exc.response is not None and exc.response.status_code in (401, 403):
                    use_massive_options = False  # 没开 Options 套餐,后续都走雅虎
                else:
                    out["errors"].append(f"{sym} 期权(massive): {exc}")
        if contracts is None:
            try:
                contracts = options_yahoo(sym)
                out["options_source"] = out["options_source"] or "yahoo"
            except Exception as exc:  # noqa: BLE001
                out["errors"].append(f"{sym} 期权(yahoo): {exc}")
        if contracts:
            spot = entry["bars"][-1][4] if entry.get("bars") else None
            if spot is None:
                try:
                    import yfinance as yf
                    spot = float(yf.Ticker(sym).fast_info["last_price"])
                except Exception:  # noqa: BLE001
                    spot = None
            entry["options"] = summarize_options(sym, contracts, spot, oi_prev, oi_next)
            entry["options"]["contracts"] = len(contracts)
        out["tickers"][sym] = entry
        done = [k for k in ("bars", "short", "options") if k in entry]
        print(f"✓ {sym}: {'/'.join(done) or '无数据'}")

    if not KEY:
        out["errors"].append("未设置 MASSIVE_API_KEY:K线/short interest 未抓取,期权走雅虎回退(见 README)")

    (ROOT / "data" / "research.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    if oi_next:
        prev_path.write_text(json.dumps(
            {"date": now.date().isoformat(), "oi": oi_next}, ensure_ascii=False))
    print(f"已写入 data/research.json(期权源: {out['options_source']}, 错误 {len(out['errors'])} 条)")


if __name__ == "__main__":
    main()
