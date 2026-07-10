#!/usr/bin/env python3
"""用 Tradier API 抓期权链(greeks + 未平仓量)并计算 Gamma Exposure(GEX)。

需要环境变量 TRADIER_TOKEN(免费注册: https://developer.tradier.com → sandbox token)。
sandbox 数据 15 分钟延迟,greeks 由 ORATS 提供、约每小时更新——对 GEX 足够,
因为核心输入 OI 每天只更新一次,盘中变化主要来自现价。
有券商账户的话可设 TRADIER_ENV=production 用实时数据。

GEX(每行权价) = gamma × OI × 100 × 现价² × 1%,call 记正、put 记负(做市商对冲惯例)
gamma flip   = 净 GEX 累计值由负转正的行权价位置

输出:
  data/gex.json          当前快照(按行权价分布、净 GEX、flip)
  data/gex_history.json  当日盘中净 GEX 时间序列(隔日自动清空)
"""
import json
import os
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
TOKEN = os.environ.get("TRADIER_TOKEN", "").strip()
ENV = os.environ.get("TRADIER_ENV", "sandbox").strip()
BASE = "https://api.tradier.com" if ENV == "production" else "https://sandbox.tradier.com"
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"}

MAX_DTE = 45          # 只统计 45 天内到期的合约(gamma 集中在近月)
MAX_EXPIRATIONS = 5   # 每只票最多取 5 个到期日
STRIKE_BAND = 0.25    # 分布图只输出现价 ±25% 的行权价(净值/flip 仍按全部计算)


def get(path: str, **params):
    resp = None
    for _ in range(3):
        resp = requests.get(f"{BASE}{path}", params=params, headers=HEADERS, timeout=30)
        if resp.status_code == 429:
            time.sleep(10)
            continue
        resp.raise_for_status()
        time.sleep(1.1)  # sandbox 限速约 60 次/分钟
        return resp.json()
    resp.raise_for_status()


def as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def compute_gex(sym: str) -> dict:
    q = get("/v1/markets/quotes", symbols=sym)["quotes"]["quote"]
    spot = q.get("last") or q.get("close") or q.get("prevclose")
    if not spot:
        raise ValueError("拿不到现价")

    exps = as_list((get("/v1/markets/options/expirations", symbol=sym)
                    .get("expirations") or {}).get("date"))
    today = date.today()
    picked = [d for d in exps
              if 0 <= (date.fromisoformat(d) - today).days <= MAX_DTE][:MAX_EXPIRATIONS]
    if not picked:
        raise ValueError("45 天内没有可用到期日(该标的可能没有期权)")

    strikes: dict[float, list[float]] = {}  # strike -> [call gamma·OI, put gamma·OI]
    contracts = 0
    for d in picked:
        chain = get("/v1/markets/options/chains", symbol=sym, expiration=d, greeks="true")
        for o in as_list((chain.get("options") or {}).get("option")):
            gamma = (o.get("greeks") or {}).get("gamma") or 0
            oi = o.get("open_interest") or 0
            if not gamma or not oi:
                continue
            slot = strikes.setdefault(float(o["strike"]), [0.0, 0.0])
            slot[0 if o.get("option_type") == "call" else 1] += gamma * oi
            contracts += 1
    if not contracts:
        raise ValueError("期权链里没有带 greeks 的合约(sandbox 的 greeks 每小时更新,稍后再试)")

    scale = 100 * spot * spot * 0.01  # 合约乘数 × spot² × 1%
    rows = [{"strike": k,
             "call": c * scale,
             "put": -p * scale,
             "net": (c - p) * scale}
            for k, (c, p) in sorted(strikes.items())]

    # gamma flip: 从低行权价向高累计净 GEX,由负转正的位置
    flip = None
    cum = 0.0
    prev_cum = prev_k = None
    for r in rows:
        cum += r["net"]
        if prev_cum is not None and prev_cum < 0 <= cum:
            flip = round((prev_k + r["strike"]) / 2, 2)
            break
        prev_cum, prev_k = cum, r["strike"]

    lo, hi = spot * (1 - STRIKE_BAND), spot * (1 + STRIKE_BAND)
    return {
        "spot": spot,
        "net_gex": sum(r["net"] for r in rows),
        "flip": flip,
        "expirations": picked,
        "by_strike": [r for r in rows if lo <= r["strike"] <= hi],
    }


def main() -> None:
    tickers = yaml.safe_load((ROOT / "config" / "options_watchlist.yml").read_text())["tickers"]
    now = datetime.now(timezone.utc)
    out = {"updated_at": now.isoformat(timespec="seconds"), "env": ENV,
           "tickers": {}, "errors": []}

    if not TOKEN:
        print("警告: 未设置 TRADIER_TOKEN,跳过 GEX", file=sys.stderr)
        out["errors"].append("未设置 TRADIER_TOKEN,GEX 未更新(注册 developer.tradier.com,见 README)")
        (ROOT / "data" / "gex.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
        return

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
