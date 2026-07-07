#!/usr/bin/env python3
"""抓取 config/sources.yml 里配置的所有 RSS/Atom 源(新闻、大V、YouTube、社区)。

输出 data/feeds.json。单个源失败不影响其他源,失败记录在 errors 里。
"""
import calendar
import json
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import feedparser
import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
UA = "stock-dashboard/1.0 (personal RSS reader)"  # Reddit 等站点会拦截默认 python UA
MAX_PER_SOURCE = 20
MAX_AGE_DAYS = 10
SUMMARY_LEN = 280

TAG_RE = re.compile(r"<[^>]+>")


def entry_time(entry) -> datetime | None:
    for attr in ("published_parsed", "updated_parsed"):
        t = getattr(entry, attr, None)
        if t:
            return datetime.fromtimestamp(calendar.timegm(t), tz=timezone.utc)
    return None


def clean_summary(entry) -> str:
    raw = getattr(entry, "summary", "") or ""
    text = TAG_RE.sub(" ", raw)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:SUMMARY_LEN] + ("…" if len(text) > SUMMARY_LEN else "")


def main() -> None:
    sources = yaml.safe_load((ROOT / "config" / "sources.yml").read_text())["sources"]
    cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_AGE_DAYS)
    items, errors = [], []

    for idx, src in enumerate(sources):
        if idx:
            time.sleep(2)  # 源之间稍作间隔,避免同站(如 Reddit)限流
        try:
            resp = requests.get(src["url"], headers={"User-Agent": UA}, timeout=30)
            if resp.status_code == 429:  # 限流则等待后重试一次
                time.sleep(15)
                resp = requests.get(src["url"], headers={"User-Agent": UA}, timeout=30)
            resp.raise_for_status()
            feed = feedparser.parse(resp.content)
            if feed.bozo and not feed.entries:
                raise ValueError(f"RSS 解析失败: {feed.bozo_exception}")
            count = 0
            for entry in feed.entries:
                ts = entry_time(entry)
                if ts and ts < cutoff:
                    continue
                items.append({
                    "source": src["name"],
                    "category": src.get("category", "news"),
                    "title": (getattr(entry, "title", "") or "").strip(),
                    "link": getattr(entry, "link", ""),
                    "published": ts.isoformat(timespec="seconds") if ts else None,
                    "summary": clean_summary(entry),
                })
                count += 1
                if count >= MAX_PER_SOURCE:
                    break
            print(f"✓ {src['name']}: {count} 条")
        except Exception as exc:  # noqa: BLE001 单个源失败不阻塞整体
            errors.append({"source": src["name"], "error": str(exc)})
            print(f"✗ {src['name']}: {exc}")

    items.sort(key=lambda i: i["published"] or "", reverse=True)
    dest = ROOT / "data" / "feeds.json"
    dest.parent.mkdir(exist_ok=True)
    dest.write_text(json.dumps({
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "items": items,
        "errors": errors,
    }, ensure_ascii=False, indent=1))
    print(f"已写入 {dest}: {len(items)} 条,失败源 {len(errors)} 个")


if __name__ == "__main__":
    main()
