#!/usr/bin/env python3
"""真实 CTA 定位:抓 DBMF(iMGP/DBi Managed Futures ETF)每日披露持仓。
DBMF 反解 SG CTA 指数(20 大趋势基金,0.88 相关),只持 10-15 个最流动期货并每日公布持仓
→ 免费、每日、真实的"趋势跟随者当前多空定位",无需假设 AUM。
数据源:stockanalysis.com 的 holdings __data.json(SvelteKit 序列化,免 key,可 headless)。
产物 data/dbmf_raw.json:latest 各资产净敞口(占 NAV 名义%,符号=多空)+ history(逐次快照)。"""
import json
import re
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "dbmf_raw.json"
URL = "https://stockanalysis.com/etf/dbmf/holdings/__data.json"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
HIST_CAP = 260

# 名称 → 资产类。顺序敏感:先股票、再利率、外汇、商品;国债现金(T-BILL)当抵押品略去。
EQUITY = ("S+P500", "S&P500", "EMINI", "E-MINI", "MSCI", "NASDAQ", "NDX", "RUSSELL",
          "DOW", "FTSE", "NIKKEI", "DAX", "STOXX", "TOPIX", "EQUITY")
RATES = ("NOTE", "BOND", "BUND", "GILT", "JGB", "BOBL", "SCHATZ", "OAT", "BTP",
         "2YR", "5YR", "10YR", "30YR", "ULTRA")
FX = ("CURR FUT", "YEN", "EURO FX", "AUSTRALIAN", "CANADIAN", "SWISS", "POUND",
      "STERLING", "PESO", "FRANC", "DOLLAR")
COMMOD = ("CRUDE", "WTI", "BRENT", "GOLD", "SILVER", "COPPER", "GAS", "CORN",
          "WHEAT", "SOYBEAN", "SUGAR", "COTTON", "OZ")


def classify(name):
    u = name.upper()
    if "TREASURY BILL" in u or "T-BILL" in u or u.strip() in ("CASH", "USD"):
        return None                       # 抵押品,非头寸
    if any(k in u for k in EQUITY):
        return "sp500" if any(k in u for k in ("S+P500", "S&P500", "EMINI", "E-MINI")) else "intl"
    if any(k in u for k in RATES):
        return "rates"
    if any(k in u for k in FX):
        return "fx"
    if any(k in u for k in COMMOD):
        return "commodity"
    return "other"


def parse_holdings(raw):
    """解 stockanalysis SvelteKit __data.json:data 是扁平数组,dict 的值是指向数组的下标。"""
    d = json.loads(raw)
    node = max(d["nodes"], key=lambda n: len(n["data"]) if isinstance(n.get("data"), list) else 0)
    A = node["data"]

    def deref(i, depth=0):
        if depth > 6:
            return None
        v = A[i]
        if isinstance(v, dict):
            return {k: deref(j, depth + 1) for k, j in v.items()}
        if isinstance(v, list):
            return [deref(j, depth + 1) for j in v]
        return v

    for e in A:
        if isinstance(e, dict) and "holdings" in e and isinstance(A[e["holdings"]], list):
            return deref(e["holdings"])
    raise RuntimeError("holdings 节点未找到")


def signed_pct(h):
    """as=|占资产%|(总正),sh=签名股数/名义(负=空)→ 签名权重。"""
    w = float(str(h.get("as", "0")).rstrip("%") or 0)
    sh = str(h.get("sh", "")).strip()
    return -w if sh.startswith("-") else w


def main():
    r = requests.get(URL, headers={"User-Agent": UA}, timeout=40)
    r.raise_for_status()
    holdings = parse_holdings(r.text)

    buckets = {"sp500": 0.0, "intl": 0.0, "rates": 0.0, "fx": 0.0, "commodity": 0.0}
    detail = []
    for h in holdings:
        if not isinstance(h, dict) or not h.get("n"):
            continue
        cls = classify(h["n"])
        if cls in (None, "other"):
            continue
        w = signed_pct(h)
        buckets[cls] = round(buckets[cls] + w, 2)
        detail.append({"n": h["n"].strip(), "w": round(w, 2), "cls": cls})
    buckets["equity"] = round(buckets["sp500"] + buckets["intl"], 2)

    asof = time.strftime("%Y-%m-%d", time.gmtime())
    snap = {**buckets}
    old = json.loads(OUT.read_text()) if OUT.exists() else {}
    hist = old.get("history", {})
    hist[asof] = snap                                    # 按日去重覆盖
    hist = dict(sorted(hist.items())[-HIST_CAP:])

    out = {"source": "DBMF(iMGP/DBi 复制器,SG CTA 指数,0.88 相关)",
           "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "asof": asof, "latest": buckets, "detail": detail, "history": hist}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"→ {OUT.relative_to(ROOT)} · asof {asof} · 股票净 {buckets['equity']:+.1f}% "
          f"(S&P {buckets['sp500']:+.1f}% / 国际 {buckets['intl']:+.1f}%) "
          f"利率 {buckets['rates']:+.1f}% 外汇 {buckets['fx']:+.1f}% 商品 {buckets['commodity']:+.1f}% "
          f"· {len(detail)} 头寸 · 历史 {len(hist)} 期")


if __name__ == "__main__":
    main()
