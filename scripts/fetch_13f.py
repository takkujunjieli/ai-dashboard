#!/usr/bin/env python3
"""精选知名机构 13F 持仓(Option B)。Massive 13F 无证券过滤、无法枚举全部持有人,
故只做"这几家名机构是否持有 watchlist 的票"。按 filer_cik 逐个查、按公司名匹配、留近 4 季度。
输出 data/holdings13f.json。13F 季度更新,低频跑(update.yml)。需 MASSIVE_API_KEY。"""
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
H = {"Authorization": f"Bearer {KEY}"}
EP = "/stocks/filings/vX/13-F"
N_QUARTERS = 4
MAX_PAGES = 6  # 单 filer 分页上限(网关每 filer ~截 1000 行/页,limit=1000)

# 精选机构(cik→展示名)。错误/无数据的 cik 自动跳过,不影响其余。
CURATED = {
    "0001067983": "Berkshire Hathaway",
    "0001037389": "Renaissance Technologies",
    "0001423053": "Citadel Advisors",
    "0001179392": "Two Sigma",
    "0001350694": "Bridgewater Associates",
    "0001603466": "Point72",
    "0001167483": "Tiger Global",
    "0001135730": "Coatue Management",
    "0001273087": "Millennium Management",
    "0001009207": "D.E. Shaw",
    "0000102909": "Vanguard Group",
    "0001364742": "BlackRock",
    "0000093751": "State Street",
}
SUFFIXES = {"INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "LTD", "LIMITED",
            "PLC", "HOLDINGS", "HLDGS", "GROUP", "GRP", "LLC", "LP", "SA", "NV", "AG",
            "CLASS", "A", "B", "C", "COM", "THE", "&", "TRUST", "TR"}


def norm(name: str) -> str:
    toks = re.sub(r"[^A-Z0-9 ]", " ", (name or "").upper()).split()
    return "".join(t for t in toks if t not in SUFFIXES)


def rebase(url):
    if not url:
        return None
    from urllib.parse import urlparse
    p = urlparse(url)
    u = f"{BASE}{p.path}" + (f"?{p.query}" if p.query else "")
    return u + ("&" if "?" in u else "?") + f"apiKey={KEY}"


def ticker_name(sym: str) -> str | None:
    try:
        r = requests.get(f"{BASE}/v3/reference/tickers/{sym}", params={"apiKey": KEY}, headers=H, timeout=30)
        return (r.json().get("results") or {}).get("name") if r.status_code == 200 else None
    except Exception:  # noqa: BLE001
        return None


def filer_holdings(cik: str) -> list:
    url = f"{BASE}{EP}?filer_cik={cik}&limit=1000&apiKey={KEY}"
    out, pages = [], 0
    while url and pages < MAX_PAGES:
        try:
            d = requests.get(url, headers=H, timeout=45).json()
        except Exception:  # noqa: BLE001
            break
        out.extend(d.get("results") or [])
        pages += 1
        url = rebase(d.get("next_url"))
    return out


def main() -> None:
    from _cfg import load_tickers
    watchlist, _ = load_tickers()
    out = {"updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "filers": CURATED, "tickers": {}, "errors": []}
    if not KEY:
        out["errors"].append("未设置 MASSIVE_API_KEY,跳过 13F")
        write(out)
        return

    norm2sym = {}          # 公司名归一 → ticker(用于把持仓匹配到 watchlist)
    for sym in watchlist:
        nm = ticker_name(sym)
        if nm:
            norm2sym[norm(nm)] = sym
    if not norm2sym:
        out["errors"].append("watchlist 公司名全拿不到,无法匹配")
        write(out)
        return

    # 按 (票, 机构, 季度) 聚合:一份 13F 里同一 issuer 可能多行(子账户/管理人),求和为总持仓。
    # 跳过期权行(put_call),只算长股(避免把 call/put notional 混进持股)。
    agg: dict = {}
    for cik, fname in CURATED.items():
        for h in filer_holdings(cik):
            sym = norm2sym.get(norm(h.get("issuer_name")))
            if not sym or h.get("put_call"):
                continue
            k = (sym, cik, h.get("period"))
            a = agg.setdefault(k, {"filer": fname, "shares": 0, "value": 0})
            if h.get("shares_or_principal_type") == "SH" and h.get("shares_or_principal_amount"):
                a["shares"] += h["shares_or_principal_amount"]
            if h.get("market_value"):
                a["value"] += h["market_value"]

    per: dict = {}
    for (sym, cik, period), a in agg.items():
        per.setdefault(sym, []).append({"filer": a["filer"], "cik": cik, "period": period,
                                        "shares": a["shares"], "value": a["value"]})
    for sym, lst in per.items():
        periods = sorted({e["period"] for e in lst if e["period"]}, reverse=True)[:N_QUARTERS]
        keep = sorted([e for e in lst if e["period"] in periods],
                      key=lambda e: (e["filer"], e["period"]), reverse=True)
        out["tickers"][sym] = {"periods": periods, "holdings": keep}

    write(out)


def write(out: dict) -> None:
    dest = ROOT / "data" / "holdings13f.json"
    dest.parent.mkdir(exist_ok=True)
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    n = sum(len(v.get("holdings", [])) for v in out["tickers"].values())
    print(f"已写入 {dest}:{len(out['tickers'])} 票有机构持仓,共 {n} 条(错误 {len(out['errors'])})")


if __name__ == "__main__":
    main()
