# 📈 股市信息 Dashboard

每天自动收集股市信息的静态 dashboard,零服务器成本:

- **结构化数据**(免费 API,无爬虫): 财报日历、EPS 实际 vs 预期、分析师评级、公司新闻 — 来自 [Finnhub 免费版](https://finnhub.io)(60 次/分钟)
- **信息流**(免费 RSS): 新闻网站、财报电话会议全文、YouTube 频道、Reddit 社区、X/雪球大V(经 RSSHub 桥接)
- **运行方式**: GitHub Actions 每天定时抓取 → JSON 存进仓库 → GitHub Pages 托管页面

## 快速开始

### 1. 注册 Finnhub 免费 key

打开 <https://finnhub.io/register> 注册,复制 API key(免费,无需信用卡)。

### 2. 推到 GitHub 并配置

```bash
gh repo create stock-dashboard --private --source . --push
gh secret set FINNHUB_API_KEY   # 粘贴你的 key
```

然后在仓库 **Settings → Pages** 里,Source 选 `Deploy from a branch`,分支选 `main` / `(root)`。

### 3. 手动触发一次验证

仓库 **Actions → 每日更新数据 → Run workflow**,跑完后访问
`https://<你的用户名>.github.io/stock-dashboard/`。

> 私有仓库的 Pages 需要 GitHub Pro;免费账号可以把仓库设为 public,或改用本地运行。

之后 Actions 会在每个交易日盘前(UTC 13:00)和每天盘后(UTC 22:30)自动更新。

## 可选: Reddit 热度排序

Reddit 已封锁匿名 JSON API,想让社区热帖按 **热度(点赞 + 2×评论)** 排序而非时间序,需要免费的 OAuth 凭证(2 分钟):

1. 打开 <https://www.reddit.com/prefs/apps> → **create app** → 类型选 **script**,name/redirect uri 随便填
2. 创建后拿到 client id(app 名字下方的一串字符)和 secret
3. 配置到 GitHub:

```bash
gh secret set REDDIT_CLIENT_ID
gh secret set REDDIT_CLIENT_SECRET
```

不配置也能正常运行:Reddit 源自动回退到 RSS,只是没有热度数据(Reddit 不公开浏览数,所以热度用点赞数代替)。

## 自定义

- **关注的股票**: 编辑 [config/watchlist.yml](config/watchlist.yml)
- **大V / 新闻源**: 编辑 [config/sources.yml](config/sources.yml),里面有 YouTube、Reddit、X(RSSHub)、雪球(RSSHub)的配置示例
  - X/Twitter 官方 API 收费,配置里用 RSSHub 桥接;公共实例 `rsshub.app` 可能限流,重度使用建议[自建 RSSHub](https://docs.rsshub.app/deploy/)(可免费部署在 Vercel)
- **更新时间**: 编辑 [.github/workflows/update.yml](.github/workflows/update.yml) 的 cron

## 本地运行

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export FINNHUB_API_KEY=你的key
python scripts/fetch_market.py   # → data/market.json
python scripts/fetch_feeds.py    # → data/feeds.json

python3 -m http.server 8000      # 打开 http://localhost:8000
```

## 目录结构

```
config/          watchlist.yml(股票) + sources.yml(信息源)
scripts/         fetch_market.py(Finnhub) + fetch_feeds.py(RSS)
data/            抓取生成的 JSON(由 Actions 自动提交)
index.html       dashboard 页面(纯静态,无需构建)
assets/          样式和渲染逻辑
```
