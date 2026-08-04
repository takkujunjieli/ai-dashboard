#!/usr/bin/env python3
"""一次性探针:Finnhub 免费档能否拿 13F/机构持仓(近 4 季度)。只读,不写文件。
跑于 probe13f.yml(需 FINNHUB_API_KEY)。"""
import json
import os

import requests

KEY = os.environ.get("FINNHUB_API_KEY", "").strip()
BASE = "https://finnhub.io/api/v1"
SYM = "AMD"


def show(label, path, **params):
    params["token"] = KEY
    print(f"\n{'='*66}\n### {label}\n  GET {path}  { {k: v for k, v in params.items() if k != 'token'} }\n{'='*66}")
    try:
        r = requests.get(f"{BASE}{path}", params=params, timeout=30)
        print(f"  HTTP {r.status_code}")
        if r.status_code != 200:
            print(f"  {r.text[:200]}")
            return
        d = r.json()
        s = json.dumps(d, ensure_ascii=False)
        print(f"  keys: {list(d.keys()) if isinstance(d, dict) else 'list'}  len~{len(s)}")
        print("  样本:\n" + json.dumps(d, ensure_ascii=False, indent=2)[:1600])
    except Exception as e:  # noqa: BLE001
        print(f"  ERR {type(e).__name__}: {str(e)[:150]}")


print(f"BASE={BASE} SYM={SYM} key={'set' if KEY else 'MISSING'}")
# ① 机构持仓(13F,按报告期)—— 最想要的:近 4 季度各机构持股
show("① institutional/ownership (13F 按报告期)", "/institutional/ownership",
     symbol=SYM, **{"from": "2025-06-01", "to": "2026-08-01"})
# ② 股东列表(当前快照,含 change)
show("② stock/ownership (股东快照)", "/stock/ownership", symbol=SYM, limit=10)
# ③ 基金持仓
show("③ stock/fund-ownership (基金)", "/stock/fund-ownership", symbol=SYM, limit=10)
# ④ 对照:免费档已用的 recommendation(确认 key 正常)
show("④ stock/recommendation (对照,已知免费)", "/stock/recommendation", symbol=SYM)
