#!/usr/bin/env python3
"""一次性探针:Massive 13F filings 端点(/stocks/filings/vX/13-F)。
确认:①是否有权限 ②能否按 cusip/ticker 过滤(决定"每股票机构持仓"可不可行)
③response 形状 ④ticker→cusip 能否从 ticker details 拿。只读,不写文件。"""
import json
import os

import requests

KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
H = {"Authorization": f"Bearer {KEY}"}
AMD_CUSIP = "007903107"


def show(label, path, **p):
    p.setdefault("apiKey", KEY)
    url = path if path.startswith("http") else f"{BASE}{path}"
    print(f"\n{'='*66}\n### {label}\n  GET {path}  { {k: v for k, v in p.items() if k != 'apiKey'} }\n{'='*66}")
    try:
        r = requests.get(url, params=p, headers=H, timeout=30)
        print(f"  HTTP {r.status_code}")
        if r.status_code != 200:
            print(f"  {r.text[:220]}")
            return
        d = r.json()
        res = d.get("results")
        if isinstance(res, list):
            print(f"  results={len(res)}  next={'Y' if d.get('next_url') else 'N'}")
            if res:
                print(f"  第一条 keys: {sorted(res[0].keys())}")
                print("  样本:\n" + json.dumps(res[0], ensure_ascii=False, indent=2)[:1400])
        else:
            print(f"  top keys: {sorted(d.keys())}\n" + json.dumps(d, ensure_ascii=False, indent=2)[:1000])
    except Exception as e:  # noqa: BLE001
        print(f"  ERR {type(e).__name__}: {str(e)[:150]}")


print(f"BASE={BASE} key={'set' if KEY else 'MISSING'}")
# ① 基本形状 + 权限
show("① 13-F 基本(limit=2)", "/stocks/filings/vX/13-F", limit=2)
# ② 能否按 cusip 过滤(决定可行性)
show("② 按 cusip 过滤 AMD", "/stocks/filings/vX/13-F", cusip=AMD_CUSIP, limit=3)
# ③ 试 ticker 过滤(文档说没有,验证下)
show("③ 按 ticker 过滤 AMD", "/stocks/filings/vX/13-F", ticker="AMD", limit=3)
# ④ period 过滤(季度)
show("④ 按 period 过滤", "/stocks/filings/vX/13-F", period="2026-03-31", limit=2)
# ⑤ ticker→cusip:ticker details 里有没有 cusip
show("⑤ ticker details 有无 cusip", "/v3/reference/tickers/AMD")
