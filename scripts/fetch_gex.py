#!/usr/bin/env python3
"""用 yfinance(雅虎财经,无需注册/无需 key)抓期权链并计算 Gamma Exposure(GEX)。

雅虎期权链带未平仓量(OI)和隐含波动率(IV)但不带 greeks——
gamma 用 Black-Scholes 从 IV 现算,对 GEX 用途足够准确。数据约 15 分钟延迟。
GEX 的核心输入 OI 每天只更新一次,盘中变化主要来自现价和 IV。

GEX(每行权价) = gamma × OI × 100 × 现价² × 1%,call 记正、put 记负(做市商对冲惯例)
gamma flip   = 净 GEX 累计值由负转正的行权价位置

输出:
  data/gex.json          当前快照(按行权价分布、净 GEX、flip)
  data/gex_history.json  当日盘中净 GEX 时间序列(隔日自动清空)
"""
import json
import math
import time
from datetime import date, datetime, timezone
from pathlib import Path

import yaml
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
RISK_FREE = 0.04      # 无风险利率,对 gamma 影响很小,取常数即可
MAX_DTE = 45          # 只统计 45 天内到期的合约(gamma 集中在近月)
MAX_EXPIRATIONS = 5   # 每只票最多取 5 个到期日
STRIKE_BAND = 0.25    # 分布图只输出现价 ±25% 的行权价(净值/flip 仍按全部计算)


def bs_gamma(spot: float, strike: float, t_years: float, iv: float) -> float:
    """Black-Scholes gamma(call 和 put 相同)。"""
    if iv <= 0 or t_years <= 0 or spot <= 0 or strike <= 0:
        return 0.0
    d1 = (math.log(spot / strike) + (RISK_FREE + iv * iv / 2) * t_years) / (iv * math.sqrt(t_years))
    return math.exp(-d1 * d1 / 2) / math.sqrt(2 * math.pi) / (spot * iv * math.sqrt(t_years))


def compute_gex(sym: str) -> dict:
    tk = yf.Ticker(sym)
    try:
        spot = float(tk.fast_info["last_price"])
    except (KeyError, TypeError):
        spot = float(tk.history(period="1d")["Close"].iloc[-1])
    if not spot or spot != spot:
        raise ValueError("拿不到现价")

    today = date.today()
    picked = [d for d in tk.options
              if 0 <= (date.fromisoformat(d) - today).days <= MAX_DTE][:MAX_EXPIRATIONS]
    if not picked:
        raise ValueError("45 天内没有可用到期日(该标的可能没有期权)")

    strikes: dict[float, list[float]] = {}  # strike -> [call gamma·OI, put gamma·OI]
    contracts = 0
    for d in picked:
        # +0.5 天近似当天剩余交易时间,避免 0DTE 除零
        t_years = ((date.fromisoformat(d) - today).days + 0.5) / 365
        chain = tk.option_chain(d)
        for side, df in ((0, chain.calls), (1, chain.puts)):
            for row in df.itertuples():
                oi, iv = row.openInterest, row.impliedVolatility
                if oi is None or oi != oi or not oi or iv is None or iv != iv:
                    continue  # 过滤 NaN/0
                g = bs_gamma(spot, float(row.strike), t_years, float(iv))
                if not g:
                    continue
                slot = strikes.setdefault(float(row.strike), [0.0, 0.0])
                slot[side] += g * float(oi)
                contracts += 1
        time.sleep(0.5)  # 对雅虎接口客气一点
    if not contracts:
        raise ValueError("期权链里没有有效合约(可能被雅虎限流,稍后再试)")

    scale = 100 * spot * spot * 0.01  # 合约乘数 × spot² × 1%
    rows = [{"strike": k,
             "call": c * scale,
             "put": -p * scale,
             "net": (c - p) * scale}
            for k, (c, p) in sorted(strikes.items())]

    # gamma flip: 累计净 GEX 的过零点;可能有多个(深度虚值区噪音),取离现价最近的
    crossings = []
    cum = 0.0
    prev_cum = prev_k = None
    for r in rows:
        cum += r["net"]
        if prev_cum is not None and (prev_cum < 0) != (cum < 0):
            crossings.append((prev_k + r["strike"]) / 2)
        prev_cum, prev_k = cum, r["strike"]
    flip = round(min(crossings, key=lambda k: abs(k - spot)), 2) if crossings else None

    lo, hi = spot * (1 - STRIKE_BAND), spot * (1 + STRIKE_BAND)
    return {
        "spot": round(spot, 2),
        "net_gex": sum(r["net"] for r in rows),
        "flip": flip,
        "expirations": picked,
        "by_strike": [r for r in rows if lo <= r["strike"] <= hi],
    }


def main() -> None:
    tickers = yaml.safe_load((ROOT / "config" / "options_watchlist.yml").read_text())["tickers"]
    now = datetime.now(timezone.utc)
    out = {"updated_at": now.isoformat(timespec="seconds"), "source": "yahoo",
           "tickers": {}, "errors": []}

    for sym in tickers:
        try:
            out["tickers"][sym] = compute_gex(sym)
            print(f"✓ {sym}: 净GEX {out['tickers'][sym]['net_gex'] / 1e9:+.2f}B, "
                  f"flip {out['tickers'][sym]['flip']}")
        except Exception as exc:  # noqa: BLE001 单个标的失败不影响其他
            out["errors"].append(f"GEX {sym}: {exc}")
            print(f"✗ {sym}: {exc}")

    (ROOT / "data" / "gex.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))

    # 当日盘中序列:隔日清空,每次运行为每只票追加一个点
    hist_path = ROOT / "data" / "gex_history.json"
    hist = {"date": "", "points": []}
    if hist_path.exists():
        try:
            hist = json.loads(hist_path.read_text())
        except json.JSONDecodeError:
            pass
    today_str = now.date().isoformat()
    if hist.get("date") != today_str:
        hist = {"date": today_str, "points": []}
    for sym, d in out["tickers"].items():
        hist["points"].append({"t": now.isoformat(timespec="seconds"),
                               "sym": sym, "net": d["net_gex"], "spot": d["spot"]})
    hist_path.write_text(json.dumps(hist, ensure_ascii=False, indent=1))
    print(f"已写入 data/gex.json + gex_history.json({len(hist['points'])} 个盘中点)")


if __name__ == "__main__":
    main()
