#!/usr/bin/env python3
"""抓取 config/sources.yml 里配置的所有 RSS/Atom 源(新闻、大V、YouTube、社区)。

输出 data/feeds.json。单个源失败不影响其他源,失败记录在 errors 里。
"""
import calendar
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import feedparser
import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
UA = "ai-dashboard/1.0 (personal RSS reader)"  # Reddit 等站点会拦截默认 python UA

# Massive 市场新闻(/v2/reference/news):有 key 才抓,只保留提及 watchlist 股票的文章
MASSIVE_KEY = os.environ.get("MASSIVE_API_KEY", "").strip()
MASSIVE_BASE = os.environ.get("MASSIVE_BASE_URL", "https://api.massive.com").rstrip("/")

# Reddit 已封锁匿名 JSON API,拿点赞/评论数需要免费的 OAuth 凭证
# 注册: https://www.reddit.com/prefs/apps → create app → 类型选 script
REDDIT_ID = os.environ.get("REDDIT_CLIENT_ID", "").strip()
REDDIT_SECRET = os.environ.get("REDDIT_CLIENT_SECRET", "").strip()
_reddit_token: str | None = None


def reddit_token() -> str:
    global _reddit_token
    if _reddit_token is None:
        resp = requests.post(
            "https://www.reddit.com/api/v1/access_token",
            auth=(REDDIT_ID, REDDIT_SECRET),
            data={"grant_type": "client_credentials"},
            headers={"User-Agent": UA},
            timeout=30,
        )
        resp.raise_for_status()
        _reddit_token = resp.json()["access_token"]
    return _reddit_token
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
    return clean_text(raw)


def clean_text(raw: str) -> str:
    text = TAG_RE.sub(" ", raw or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text[:SUMMARY_LEN] + ("…" if len(text) > SUMMARY_LEN else "")


def parse_reddit(src: dict, payload: dict, cutoff: datetime) -> list[dict]:
    """解析 Reddit JSON API,带点赞/评论数,热度 = 点赞 + 2×评论(Reddit 不公开浏览数)。"""
    items = []
    for child in payload.get("data", {}).get("children", []):
        d = child.get("data", {})
        if d.get("stickied"):  # 跳过置顶公告帖
            continue
        ts = datetime.fromtimestamp(d.get("created_utc", 0), tz=timezone.utc)
        if ts < cutoff:
            continue
        score = int(d.get("score", 0))
        comments = int(d.get("num_comments", 0))
        items.append({
            "source": src["name"],
            "category": src.get("category", "community"),
            "title": (d.get("title") or "").strip(),
            "link": "https://www.reddit.com" + d.get("permalink", ""),
            "published": ts.isoformat(timespec="seconds"),
            "summary": clean_text(d.get("selftext", "")),
            "score": score,
            "comments": comments,
            "heat": score + 2 * comments,
        })
        if len(items) >= MAX_PER_SOURCE:
            break
    return items


def fetch_massive_news(watchlist: list[str], cutoff: datetime) -> list[dict]:
    """Massive 市场新闻(免费档可用),一次调用取市场最新新闻,只留提及 watchlist 股票的文章。
    每篇带命中的票 + Massive 情绪分析(insights)。"""
    wl = set(watchlist)
    since = cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")
    params = {"apiKey": MASSIVE_KEY, "limit": 100, "sort": "published_utc",
              "order": "desc", "published_utc.gte": since}
    resp = requests.get(f"{MASSIVE_BASE}/v2/reference/news", params=params,
                        headers={"Authorization": f"Bearer {MASSIVE_KEY}", "User-Agent": UA}, timeout=30)
    resp.raise_for_status()
    out = []
    for r in resp.json().get("results") or []:
        tks = [t for t in (r.get("tickers") or []) if t in wl]
        if not tks:
            continue  # 只保留提及 watchlist 股票的新闻
        senti = next((i for i in (r.get("insights") or []) if i.get("ticker") in wl), {})
        out.append({
            "source": "Massive · " + ((r.get("publisher") or {}).get("name") or "News"),
            "category": "news",
            "title": (r.get("title") or "").strip(),
            "link": r.get("article_url"),
            "published": (r.get("published_utc") or "")[:19] or None,
            "summary": clean_text(r.get("description") or ""),
            "tickers": tks,
            "sentiment": senti.get("sentiment"),
        })
        if len(out) >= MAX_PER_SOURCE:
            break
    return out


def main() -> None:
    sources = yaml.safe_load((ROOT / "config" / "sources.yml").read_text())["sources"]
    cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_AGE_DAYS)
    items, errors = [], []

    # 带 filter_watchlist: true 的源(如 SA 财报电话会全文)只保留 watchlist 里的股票。
    # SA transcript 标题形如 "Company Name (TICKER) ... Transcript",按 (TICKER) 精确匹配,
    # 括号包裹可避免裸票代码误命中(如 U、AA 出现在普通词里)。
    watchlist = (json.loads((ROOT / "config" / "tickers.json").read_text()).get("watchlist") or [])
    wl_pat = re.compile(r"\((" + "|".join(re.escape(t) for t in watchlist) + r")\)") if watchlist else None

    reddit_degraded = False
    for idx, src in enumerate(sources):
        if idx:
            time.sleep(2)  # 源之间稍作间隔,避免同站(如 Reddit)限流
        try:
            url, headers = src["url"], {"User-Agent": UA}
            is_reddit = "reddit.com" in url and ".json" in url
            if is_reddit and REDDIT_ID and REDDIT_SECRET:
                # 官方 OAuth API: 免费 100 次/分钟,最稳
                url = url.replace("www.reddit.com", "oauth.reddit.com").replace(".json", "")
                headers["Authorization"] = f"bearer {reddit_token()}"

            resp = requests.get(url, headers=headers, timeout=30)
            if resp.status_code == 429:  # 限流则等待后重试一次
                time.sleep(15)
                resp = requests.get(url, headers=headers, timeout=30)

            if is_reddit and resp.status_code in (403, 429):
                # 匿名 JSON 被 Reddit 拒绝 → 回退 RSS,靠 hot 榜排名排序(无具体数值)
                rss_url = re.sub(r"\.json", "/.rss", src["url"])
                time.sleep(5)
                resp = requests.get(rss_url, headers={"User-Agent": UA}, timeout=30)
                if resp.status_code == 429:
                    time.sleep(20)
                    resp = requests.get(rss_url, headers={"User-Agent": UA}, timeout=30)
                is_reddit = False
                reddit_degraded = True
            resp.raise_for_status()

            if is_reddit:
                new_items = parse_reddit(src, resp.json(), cutoff)
                items.extend(new_items)
                print(f"✓ {src['name']}: {len(new_items)} 条(含热度)")
                continue

            feed = feedparser.parse(resp.content)
            if feed.bozo and not feed.entries:
                raise ValueError(f"RSS 解析失败: {feed.bozo_exception}")
            count = 0
            for entry in feed.entries:
                ts = entry_time(entry)
                if ts and ts < cutoff:
                    continue
                title = (getattr(entry, "title", "") or "").strip()
                if src.get("filter_watchlist") and wl_pat and not wl_pat.search(title):
                    continue  # 只保留 watchlist 里股票的条目
                item = {
                    "source": src["name"],
                    "category": src.get("category", "news"),
                    "title": title,
                    "link": getattr(entry, "link", ""),
                    "published": ts.isoformat(timespec="seconds") if ts else None,
                    "summary": clean_summary(entry),
                }
                if item["category"] == "community":
                    item["rank"] = count  # hot 榜排名,无热度数值时用它排序
                items.append(item)
                count += 1
                if count >= MAX_PER_SOURCE:
                    break
            print(f"✓ {src['name']}: {count} 条")
        except Exception as exc:  # noqa: BLE001 单个源失败不阻塞整体
            errors.append({"source": src["name"], "error": str(exc)})
            print(f"✗ {src['name']}: {exc}")

    if reddit_degraded:
        errors.append({
            "source": "Reddit",
            "error": "匿名 JSON 被拒,已回退 RSS — 社区帖按 hot 榜排名排序但无点赞/评论数;配置 OAuth 可显示数值,见 README",
        })

    # Massive 市场新闻(仅 watchlist 相关),有 key 才抓
    if MASSIVE_KEY and watchlist:
        try:
            mn = fetch_massive_news(watchlist, cutoff)
            items.extend(mn)
            print(f"✓ Massive 新闻: {len(mn)} 条(watchlist 相关)")
        except Exception as exc:  # noqa: BLE001
            errors.append({"source": "Massive News", "error": str(exc)})
            print(f"✗ Massive 新闻: {exc}")

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
