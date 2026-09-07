#!/usr/bin/env python3
"""CFTC COT — Traders in Financial Futures(TFF)。抓 E-mini S&P 500 + E-mini Nasdaq 逐周
cohort 净持仓:Leveraged Funds(HF/CTA)、Asset Manager(资管/共同基金)、Dealer。供仓位情报页。
免 key(CFTC Socrata 公开 API)。产物 data/cot_raw.json(全历史,~20 年周频)。"""
import json
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "cot_raw.json"
API = "https://publicreporting.cftc.gov/resource/gpe5-46if.json"
CONTRACTS = {"SP500": "E-MINI S&P 500", "NDX100": "NASDAQ MINI"}
MULT = {"SP500": 50, "NDX100": 20}   # 合约乘数($/点):E-mini S&P=$50×SPX, E-mini Nasdaq=$20×NDX


def fetch(contract_name):
    params = {
        "$where": f"contract_market_name = '{contract_name}'",
        "$select": ",".join([
            "report_date_as_yyyy_mm_dd",
            "lev_money_positions_long", "lev_money_positions_short",
            "asset_mgr_positions_long", "asset_mgr_positions_short",
            "dealer_positions_long_all", "dealer_positions_short_all",
            "open_interest_all",
            "change_in_lev_money_long", "change_in_lev_money_short",
            "change_in_asset_mgr_long", "change_in_asset_mgr_short",
        ]),
        "$order": "report_date_as_yyyy_mm_dd ASC",
        "$limit": 5000,
    }
    r = requests.get(API, params=params, timeout=60)
    r.raise_for_status()

    def n(x, k):
        try:
            return int(float(x.get(k) or 0))
        except (TypeError, ValueError):
            return 0

    out = []
    for x in r.json():
        out.append({
            "date": (x.get("report_date_as_yyyy_mm_dd") or "")[:10],
            "lev_net": n(x, "lev_money_positions_long") - n(x, "lev_money_positions_short"),
            "am_net": n(x, "asset_mgr_positions_long") - n(x, "asset_mgr_positions_short"),
            "dealer_net": n(x, "dealer_positions_long_all") - n(x, "dealer_positions_short_all"),
            "lev_chg": n(x, "change_in_lev_money_long") - n(x, "change_in_lev_money_short"),
            "am_chg": n(x, "change_in_asset_mgr_long") - n(x, "change_in_asset_mgr_short"),
            "oi": n(x, "open_interest_all"),
        })
    return out


def main():
    data = {"updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "mult": MULT, "contracts": {}}
    for key, name in CONTRACTS.items():
        try:
            rows = fetch(name)
            data["contracts"][key] = rows
            print(f"{key} ({name}): {len(rows)} 周  {rows[0]['date']}→{rows[-1]['date']}  "
                  f"最新 lev_net={rows[-1]['lev_net']:,} am_net={rows[-1]['am_net']:,}")
        except Exception as e:
            print(f"✗ {key} ({name}) 失败: {e}")
            data["contracts"][key] = []
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":")))
    print(f"→ {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
