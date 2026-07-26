#!/usr/bin/env python3
"""一次性探针:确认网关对 ①单票详情(shares_outstanding/market_cap)②财务报表 financials
③Benzinga 分析师/财报套件 的支持与字段形状。只读,不写文件。跑于 probefund.yml。
"""
import json
import os

import requests

KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")
H = {"Authorization": f"Bearer {KEY}"}
SYM = "AMD"


def get(path, **p):
    p.setdefault("apiKey", KEY)
    url = path if path.startswith("http") else f"{BASE}{path}"
    return requests.get(url, params=p, headers=H, timeout=30)


def show(label, path, **p):
    print(f"\n{'='*70}\n### {label}\n  GET {path}  {p}\n{'='*70}")
    try:
        r = get(path, **p)
        print(f"  HTTP {r.status_code}")
        if r.status_code != 200:
            print(f"  {r.text[:200]}")
            return None
        d = r.json()
        res = d.get("results")
        if isinstance(res, list):
            print(f"  results 数: {len(res)}  next_url: {'Y' if d.get('next_url') else 'N'}")
            if res:
                print(f"  第一条 keys: {sorted(res[0].keys())}")
                print(f"  第一条样本:\n{json.dumps(res[0], ensure_ascii=False, indent=2)[:1500]}")
        elif isinstance(res, dict):
            print(f"  results keys: {sorted(res.keys())}")
            print(f"  样本:\n{json.dumps(res, ensure_ascii=False, indent=2)[:1500]}")
        else:
            print(f"  top-level keys: {sorted(d.keys())}")
            print(json.dumps(d, ensure_ascii=False, indent=2)[:1200])
        return d
    except Exception as e:  # noqa: BLE001
        print(f"  ERR {type(e).__name__}: {str(e)[:150]}")
        return None


print(f"BASE={BASE}  SYM={SYM}  key={'set' if KEY else 'MISSING'}")

# ① 单票详情 — 找 shares_outstanding / weighted_shares_outstanding / market_cap
show("① Ticker Details v3", f"/v3/reference/tickers/{SYM}")

# ② 财务报表
show("② Financials vX", "/vX/reference/financials", ticker=SYM, limit=1)

# ③ Benzinga 套件(逐个探;不同网关命名可能不同)
for label, path in [
    ("③a Benzinga ratings", "/benzinga/v1/ratings"),
    ("③b Benzinga consensus-ratings", "/benzinga/v1/consensus-ratings"),
    ("③c Benzinga analyst-insights", "/benzinga/v1/analyst-insights"),
    ("③d Benzinga earnings", "/benzinga/v1/earnings"),
    ("③e Benzinga guidance", "/benzinga/v1/guidance"),
    ("③f Benzinga firms", "/benzinga/v1/firms"),
]:
    show(label, path, ticker=SYM, limit=2)

# 对照:是否有 dividends / splits(splits 后续用)
show("④ Splits v3", "/v3/reference/splits", ticker=SYM, limit=2)
