#!/usr/bin/env python3
"""验证流量分类 GEX:对 AMD 跑真实 compute_gex_flow,和名义 compute_gex 对比。不写数据文件。"""
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_research as fr  # noqa: E402

SYM = "AMD"


def main():
    # 现价
    q = fr.mget(f"/v2/aggs/ticker/{SYM}/prev")
    spot = (q.get("results") or [{}])[0].get("c")
    print(f"{SYM} prev close ≈ {spot}")

    contracts = fr.options_massive(SYM, spot)
    print(f"抓到合约数(±20%/≤45天): {len(contracts)}")

    naive = fr.compute_gex(contracts, spot)
    errs = []
    flow = fr.compute_gex_flow(SYM, spot, contracts, errs)
    if flow is None:
        print("流量版为空(可能非交易时段无成交可分类)")
    else:
        print(f"实际分类到的合约数: {flow.get('classified')}")
    for b in ("0dte", "week", "2wk", "all"):
        nb = (naive["buckets"][b]["net_gex"]) / 1e6
        fb = (flow["buckets"][b]["net_gex"] / 1e6) if flow else None
        nf = naive["buckets"][b]["flip"]
        ff = flow["buckets"][b]["flip"] if flow else None
        print(f"  [{b}] 名义净GEX={nb:+.0f}M flip={nf}  |  流量净GEX={fb if fb is None else f'{fb:+.0f}M'} flip={ff}")
    if errs:
        print(f"分类错误 {len(errs)} 条,样例: {errs[0]}")


if __name__ == "__main__":
    main()
