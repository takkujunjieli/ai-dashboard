#!/usr/bin/env python3
"""Attention 项:Google Trends 每日搜索量(SVI, Da-Engelberg-Gao 2011)。
对 retail_syms(散户流选取)逐票拉近 3 个月日频 SVI,滚动并入 data/retail_trends.json。

best-effort:Google 常对数据中心 IP 限流(429),失败/缺 pytrends 时静默跳过——
build_retailflow 会自动退回 netbuy×intensity 两项信号。不阻塞主管线。

env: RF_SYMS(逗号覆盖标的)· RF_WINDOW(滚动天数, 默认 30)· TR_KW_SUFFIX(默认 " stock")
"""
import json
import os
import time
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "retail_trends.json"
WINDOW = int(os.environ.get("RF_WINDOW", "30"))
SUFFIX = os.environ.get("TR_KW_SUFFIX", " stock")


def main():
    try:
        from pytrends.request import TrendReq
    except Exception:
        print("⚠️ 无 pytrends,跳过 Attention(信号退回 netbuy×intensity)"); return

    rp = ROOT / "config" / "retail_syms.json"
    default = (json.loads(rp.read_text()).get("symbols", []) if rp.exists() else ["HOOD", "COIN", "RKLB"])
    syms = ([s.strip().upper() for s in os.environ.get("RF_SYMS", "").split(",") if s.strip()]
            or [s.strip().upper() for s in default if s and s.strip()])
    store = {"updated": None, "data": {}}
    if OUT.exists():
        try:
            store = json.loads(OUT.read_text())
        except Exception:
            pass
    store.setdefault("data", {})

    py = TrendReq(hl="en-US", tz=0, retries=2, backoff_factor=0.5)
    cutoff = (date.today() - timedelta(days=WINDOW)).isoformat()
    ok = 0
    for s in syms:
        kw = f"{s}{SUFFIX}"
        try:
            py.build_payload([kw], timeframe="today 3-m")
            df = py.interest_over_time()
            if df is None or df.empty or kw not in df:
                print(f"  {s}: 空"); continue
            ser = store["data"].setdefault(s, {})
            for ts, row in df.iterrows():
                if bool(row.get("isPartial")):
                    continue
                ser[ts.strftime("%Y-%m-%d")] = int(row[kw])
            # 滚动裁剪
            store["data"][s] = {d: v for d, v in ser.items() if d >= cutoff}
            ok += 1
            print(f"  {s}: {len(store['data'][s])} 天 SVI (最新 {max(store['data'][s]) if store['data'][s] else '—'})")
        except Exception as exc:
            print(f"  ✗ {s}: {exc}(限流/网络,跳过)")
        time.sleep(2)   # 礼貌间隔,降 429

    store["updated"] = date.today().isoformat()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(store, ensure_ascii=False, separators=(",", ":")))
    print(f"\n{ok}/{len(syms)} 票有 SVI → {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
