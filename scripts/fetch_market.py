#!/usr/bin/env python3
"""从 Finnhub 免费 API 抓取 watchlist 的行情、财报日历、EPS、分析师评级、公司新闻。

输出 data/market.json。需要环境变量 FINNHUB_API_KEY(免费注册: https://finnhub.io)。
免费版限额 60 次/分钟,脚本内置节流。
"""
import json
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://finnhub.io/api/v1"
API_KEY = os.environ.get("FINNHUB_API_KEY", "").strip()


def get(path: str, **params):
    params["token"] = API_KEY
    resp = None
    for _ in range(3):
        resp = requests.get(f"{BASE}{path}", params=params, timeout=30)
        if resp.status_code == 429:  # 触发限流,等一等再试
            time.sleep(15)
            continue
        resp.raise_for_status()
        time.sleep(1.1)  # 免费版 60 次/分钟
        return resp.json()
    resp.raise_for_status()


def main() -> None:
    watchlist = yaml.safe_load((ROOT / "config" / "watchlist.yml").read_text())["tickers"]
    out = {
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "watchlist": watchlist,
        "quotes": {},
        "earnings_calendar": [],
        "earnings_surprises": {},
        "recommendations": {},
        "company_news": {},
        "errors": [],
    }

    if not API_KEY:
        print("警告: 未设置 FINNHUB_API_KEY,跳过行情/财报数据", file=sys.stderr)
        out["errors"].append("未设置 FINNHUB_API_KEY,行情与财报数据未更新")
        write(out)
        return

    today = date.today()

    # 财报日历: 过去 7 天 ~ 未来 21 天,只保留 watchlist 内的
    try:
        cal = get(
            "/calendar/earnings",
            **{"from": (today - timedelta(days=7)).isoformat(),
               "to": (today + timedelta(days=21)).isoformat()},
        )
        symbols = set(watchlist)
        out["earnings_calendar"] = sorted(
            (e for e in cal.get("earningsCalendar", []) if e.get("symbol") in symbols),
            key=lambda e: e.get("date", ""),
        )
    except Exception as exc:  # noqa: BLE001 单项失败不影响整体
        out["errors"].append(f"财报日历: {exc}")

    for sym in watchlist:
        for key, fetch in (
            ("quotes", lambda s=sym: get("/quote", symbol=s)),
            ("earnings_surprises", lambda s=sym: get("/stock/earnings", symbol=s)),
            ("recommendations", lambda s=sym: get("/stock/recommendation", symbol=s)),
            ("company_news", lambda s=sym: get(
                "/company-news", symbol=s,
                **{"from": (today - timedelta(days=3)).isoformat(), "to": today.isoformat()},
            )[:10]),
        ):
            try:
                out[key][sym] = fetch()
            except Exception as exc:  # noqa: BLE001
                out["errors"].append(f"{sym} {key}: {exc}")

    write(out)


def write(out: dict) -> None:
    dest = ROOT / "data" / "market.json"
    dest.parent.mkdir(exist_ok=True)
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"已写入 {dest} (错误 {len(out['errors'])} 条)")


if __name__ == "__main__":
    main()
