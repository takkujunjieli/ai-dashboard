# AI Dashboard · 架构与交接文档 (Handoff)

> 短线研究系统。**静态托管、零服务器成本**:GitHub Actions 定时抓数 → JSON 提交进仓库 → GitHub Pages 托管纯静态页面。
> 本文是**当前状态**的总览(2026-09);`docs/1-系统构建.md`、`docs/3-数据与存储.md` 等是早期细节文档,部分已过时,以本文为准。

---

## 0. TL;DR / 快速上手

| 你想干嘛 | 怎么做 |
|---|---|
| 本地看页面 | `python3 -m http.server 8000` → `http://localhost:8000/trading.html`(ES module 有缓存,看不到改动就 `Cmd+Shift+R`) |
| 公开站 | https://takkujunjieli.github.io/ai-dashboard/ |
| **改了前端要上线** | commit + push main → **必须** `gh workflow run deploy.yml`(push 本身不部署,见 §9) |
| 刷新持仓 | Claude 调 Robinhood 只读 MCP → 归一 → `python3 scripts/build_portfolio.py`(本地,见 §7) |
| 改个股打分 | 改**私有库**的 `build_scorecards.py` → `python3 scripts/build_scorecards.py`(见 §8) |
| 盘中 K 线不更新 | GitHub cron 偶发跳过 → `gh workflow run gex.yml` 手动启动(见 §12) |
| push 前 | 先 `gh auth switch --user takkujunjieli`(个人仓库,见 §12) |

**技术栈**:纯静态 HTML + vanilla ES modules(无构建步骤)· lightweight-charts(TradingView)· Python(纯 stdlib + 少量库)· GitHub Actions + Pages。

---

## 1. 架构总览

```
数据源(Finnhub/Massive/Yahoo/FRED/RSS)
      │  (GitHub Actions 定时/手动)
      ▼
scripts/fetch_*.py  →  data/*.json
      │
      ├─ 提交到 main(EOD 基线 + Pages 兜底)
      └─ 镜像到 data 分支(前端盘中实时源,push_data.py)
      │
      ▼
GitHub Pages(deploy.yml 用 workflow 部署 main)
      │
      ▼
浏览器:纯静态页 + ES module
      ├─ loadJSON("data/x.json")         → 相对路径(Pages/main 的 EOD 基线)
      └─ loadFreshJSON("data/x.json")    → GitHub contents API ?ref=data(盘中最新);失败回退 loadJSON
```

- **零服务器**:没有后端。所有"实时性"靠前端直接调 GitHub contents API 从 `data` 分支拉最新 JSON(见 §5)。
- **两条数据新鲜度**:`main` 上是每日 EOD 基线(Pages 部署的兜底);`data` 分支是盘中高频快照(前端优先读)。
- **私有数据**:持仓/盈亏/打分等敏感数据**不进公开库**,放独立私有库,用符号链接接进来(见 §6,**核心设计**)。

---

## 2. 页面与功能(4 个页面)

顶部有统一的 **sticky tab 栏**(`.pagenav`,`assets/style.css`,每页硬编码当前页 `active`):**🏠 Info · ⚡ Trading · 🔬 Research · 🧪 Strategy**。

| 页面 | 文件 | 主要内容 |
|---|---|---|
| **🏠 Info** | `index.html` + `app.js` | 页内分区 tab:🏠 Home(机构 13F 持仓 + 行情概览)/📰 News(财报日历、宏观/公司新闻 RSS)/💬 Social(Reddit/X/雪球 按热度)。顶部 ticker 筛选。 |
| **⚡ Trading** | `trading.html` + `trading.js` | 迷你报价卡(ticker set 切换)· **Price & GEX**(5min K 线 + 行权价 GEX 阶梯 + AVWAP + 指标副图)· **Options Panel**(ATM IV/skew/term/VRP/PCR/Max Pain/premium C-P/最活跃档)· **💼 Portfolio**(见 §7)· **📊 Scorecards**(见 §8)· **🎛️ Collection**(手动启动盘中采集) |
| **🔬 Research** | `research.html` + `research.js` | 研究模块(topic 化,如 熊/牛预测)。读 `research_bearbull.json` 等。 |
| **🧪 Strategy** | `strategy.html` + `strategy.js` | **📈 5Y 走势聚合**(左轴 SPY/QQQ/IWM 归一100,右轴 US 10/30Y 收益率%,读 `rates.json`)· Backtest Summary/Metrics/Equity Curve/Walk-forward OOS/Trades(读 `strategy_bt.json`)· GEX→次日波动研究 |

---

## 3. 数据源

| 源 | 用途 | 认证 |
|---|---|---|
| **Finnhub** | 行情/EPS/财报日历/公司新闻 | `FINNHUB_API_KEY`(secret) |
| **Massive**(原 Polygon) | K线/short interest/期权链/GEX | `MASSIVE_API_KEY` + **自定义网关** `MASSIVE_BASE_URL`(仓库变量,见 §12 安全) |
| **Yahoo**(yfinance / v8 chart) | 期权链回退 + GEX 现算 + 指数价格(rates) | 无(零注册) |
| **FRED** | US 10/30Y 国债收益率日频 | **免 key**(`fredgraph.csv` 端点) |
| **RSS** | 新闻/Reddit/X(RSSHub)/雪球(RSSHub) | Reddit OAuth 可选(`REDDIT_CLIENT_ID/SECRET`) |

---

## 4. 数据产物(`data/*.json`)

| 文件 | 内容 | 公开? |
|---|---|---|
| `market.json` | 行情/EPS/评级(Finnhub) | ✅ |
| `research.json` | 每票深度:K线/short/期权面板指标/指标/新闻 | ✅ |
| `gex.json` / `gex_daily` / `gex_week` / `gex_history` | GEX 按行权价/到期/净GEX/flip/墙 | ✅ |
| `iv_obs.json` | IV 期权链观测(每档 strike/CP/delta/IV/价格) | ✅ |
| `bars_intraday.json` | 盘中 K 线 | ✅ |
| `flow_*` / `oi_*` | Lee-Ready 逐笔主动买卖、OI 变化对账 | ✅ |
| `holdings13f.json` | 精选机构 13F 持仓 | ✅ |
| `feeds.json` | 新闻/社区 RSS | ✅ |
| `rates.json` | US 10/30Y + SPY/QQQ/IWM 5Y 日频(聚合图) | ✅ |
| `retail_*` / `research_bearbull.json` | 散户流向、研究模块 | ✅ |
| `strategy_bt.json` | 回测结果 | ✅ |
| **`portfolio.json`** | 券商持仓合并 | ❌ gitignore(本地) |
| **`pnl.json`** | 盈亏诊断 | ❌ gitignore(本地) |
| **`portfolio_history.json`** | 持仓快照历史 | ❌ gitignore(本地) |
| **`_rh_raw.json` / `_takku_raw.json`** | 券商原料 | ❌ **符号链接 → 私有库** |
| `atr.json` | ATR 指标 | ❌ gitignore(当前) |

---

## 5. 前端

- **无构建**:`assets/*.js` 是原生 ES module。每页一个入口(`app.js`/`trading.js`/`research.js`/`strategy.js`),都 `import from "./shared.js"`。
- **`shared.js` 关键常量 `REPO = "takkujunjieli/ai-dashboard"`**:前端走 contents API 拉 `data` 分支就靠它。**改仓库名必须同步改它**,否则盘中数据 404(见 §12 改名踩坑)。
- 两个取数函数:
  - `loadJSON(path)` = `fetch(相对路径)` → Pages/main 上的 EOD 基线。**portfolio.json、rates.json 等走这个**。
  - `loadFreshJSON(path)` = `fetch(api.github.com/repos/${REPO}/contents/${path}?ref=data)`(盘中高频数据只在 `data` 分支),带 PAT 认证(5000/h)否则匿名(60/h),失败回退 `loadJSON`。
- **图表**:lightweight-charts(CDN 全局 `LightweightChart`);GEX 阶梯/直方图/饼图等是手绘 SVG。
- **Cache-busting**:`scripts/cache_bust.sh` 在部署时把 HTML 引用的 `assets/*.css|js` 及入口 JS 内部 `./shared.js` import 追加 `?v=<commit短SHA>`(只改 CI artifact,不动源码)。根治 ES module 浏览器缓存(见 §12)。

---

## 6. ⭐ 双仓库设计(公开 + 私有 + 符号链接)—— 核心

**为什么**:仓库公开发布到 Pages。持仓/盈亏/个股打分及理由是私人财务/研究数据,**绝不能进公开库**。所以拆两个仓库,用符号链接把私有数据"接"进公开库的工作目录(链接本身被 gitignore,不会提交)。

```
~/personal-projects/
├── ai-dashboard/                 ← 公开库 takkujunjieli/ai-dashboard(部署到 Pages)
│   ├── data/_rh_raw.json         ─┐ 符号链接(相对 ../../),gitignore
│   ├── data/_takku_raw.json      ─┤
│   ├── research/scorecards       ─┤
│   └── scripts/build_scorecards.py ┘
│         全部 → ../../stock-dashboard-private/...
│
└── stock-dashboard-private/      ← 私有库 takkujunjieli/stock-dashboard-private(**未改名**)
    ├── _rh_raw.json              券商原料(hui)
    ├── _takku_raw.json           券商原料(Takku)
    ├── build_scorecards.py       打分生成器(内嵌全部分数/理由)
    └── scorecards/               每股 <TK>.csv + _summary.csv
```

- **符号链接是相对路径 `../../stock-dashboard-private/...`**,不含公开库名 → 公开库改名不影响链接。
- **符号链接被 gitignore**(公开库),所以**不随 git 同步**:换新机器要 clone 两个库后**手动重建链接**:
  ```bash
  cd ai-dashboard
  ln -s ../../stock-dashboard-private/scorecards research/scorecards
  ln -s ../../stock-dashboard-private/build_scorecards.py scripts/build_scorecards.py
  ln -s ../../stock-dashboard-private/_rh_raw.json data/_rh_raw.json
  ln -s ../../stock-dashboard-private/_takku_raw.json data/_takku_raw.json
  ```
- 公开库 `.gitignore` 挡下的私有内容:`data/portfolio.json`、`data/pnl.json`、`data/portfolio_history.json`、`data/_*_raw.json`、`research/`、`analysis/`、`scripts/build_scorecards.py`、`data/atr.json`。
- 私有库改分/刷新后要**单独 push 私有库**才同步远端(见 §7/§8)。

---

## 7. Portfolio 子系统

**数据流**:Robinhood 只读 MCP → 归一 → `data/_<broker>_raw.json`(私有库) → `build_portfolio.py` → `portfolio.json` + `pnl.json`(本地 gitignore) → 交易台 💼 面板读。

- **Robinhood MCP 是只读**:`.claude/settings.json` 的 `permissions.deny` 硬禁 19 个写工具(下单/撤单/行权/review + watchlist/scan 增改),harness 强制拦截。**Claude 绝不下单/经手凭证**。
- **一个 MCP 连接 = 一个 Robinhood 登录**。当前两个账户是**两套独立登录**:
  - `hui`(id `rh-7159` = 账号 `640267159`)
  - `Takku·个人(Margin)`(id `takku-rh-2566` = 账号 `894432566`)
  - 切换靠**用户重新 connect** MCP 到另一个登录(hui↔Takku);Claude 不能切。
- **刷新单账户的正确做法(别毁 PnL)**:MCP 拉的是**当前持仓 + 近端订单**,不是全历史;而 `analyze_pnl.py` 按**整段交易史**算已实现盈亏。所以**绝不能整份覆盖 raw**,要**合并**:保留旧 raw 全历史交易,只 append 上次最后一笔之后的新成交(按 ts秒+sym+side+qty+price **去重**),positions 换最新快照。side 用 Robinhood **原始值**(buy/sell/sell_short/buy_to_cover)与基线一致。
- `build_portfolio.py`:合并各 `_*_raw.json` → `portfolio.json`(含 accounts 列表供 UI 下拉);交易明细裁到最近 `TX_KEEP_DAYS=90` 天;末尾自动调 `analyze_pnl.py` 生成 `pnl.json`。
- **持仓不公开**(2026-08 改回私有):刷新后只需重建本地文件,**不 push、不 deploy**(公开站不显示持仓)。但券商原料的改动要 **push 私有库**留存。
- **positions 过滤规则**:raw 里只留 `|qty|>=2` 股的股票(滤零头/1股),期权按合约数不受此规则。
- **面板特性**(`trading.js` renderPortfolio):账户下拉筛选、多头/空头**双饼图**(空头按 |市值| 分块)、跨账户**同 sym 合并**、交易明细种类(正股/期权)+持仓变化列+分页(20/页)。

---

## 8. Scorecards 子系统

**8-feature 个股打分**:Operation / Capital Allocation / Financial Health / Valuation / Macro / Industry / Institution / News。

- **生成器 `build_scorecards.py` 实体在私有库**(内嵌全部分数/理由),公开库是符号链接且 gitignore。
- **schema**:每个 feature 是 `(now现状, fwd前瞻, rationale)` 三元组,分值区间 **-5~+5**(0=中性,正=看多/好,负=看空/差)。某分未知填 `inf` → 从总分剔除、按已知权重归一、显示 `?`。方向 `L/S/W`(多/空/Watch)。权重默认统一(Op .20 CA .08 FH .10 Val .22 Mac .12 Ind .15 Inst .05 News .08)。
- **改分流程**:改私有库 `build_scorecards.py` 的 `STOCKS` → `python3 scripts/build_scorecards.py`(经链接写到私有库 `scorecards/`)→ 浏览器刷新。可跨终端 clone 私有库编辑。
- **输出**:每股 `<TK>.csv`(现状/前瞻/加权)+ `_summary.csv`(每股一行,每 feature `现状/前瞻`)。
- **展示**:`trading.html` 的 `#scorecards` 热力表读 `_summary.csv`(`loadText`+`parseCSV`);**红=负、绿=正、深浅随 |分|**;方向徽标 多/空/观;PositionCheck 检查仓位方向与分数是否自洽。

---

## 9. GitHub Actions / Workflows

| workflow | 触发 | 做什么 |
|---|---|---|
| **update.yml**(每日更新数据) | schedule + 手动 | fetch_market/13f/feeds/research/**rates** → 提交 `data` 到 main → `push_data.py` 镜像 data 分支 → **deploy job 部署 Pages** |
| **gex.yml**(盘中滚动采集) | `schedule: 25 13 * * 1-5` + 手动 | `collect_session.py` 滚动采集 K线/GEX 到收盘;近 6h 上限时**自续接力**(`gh workflow run -R $GITHUB_REPOSITORY`,不硬编码 repo) |
| **deploy.yml**(仅部署 Pages) | **仅手动** `workflow_dispatch` | checkout main → `cache_bust.sh` → upload-pages-artifact → deploy-pages |
| **squash_data.yml** | schedule | 压平 `data` 分支历史(防膨胀) |
| retailflow / backtest / flow* / probe* / diag | 各自 | 散户流、回测、flow 方法对比、探针诊断 |

> **⚠️ Pages 是 workflow 部署,push 到 main 不会自动发布。** 改前端后必须 `gh workflow run deploy.yml`。update.yml 每日跑完也带 deploy job,所以数据每天会自动重发。

---

## 10. Config(`config/`)

| 文件 | 作用 |
|---|---|
| `watchlist.yml` | 深度数据(K线/GEX/期权)覆盖的标的 |
| `tickers.json` | ticker 分组(deep / watch),卡片开关就地编辑、防抖写回 |
| `sources.yml` | RSS 源(新闻/YouTube/Reddit/X/雪球) |
| `risk_policy.json` | 仓位风险标注(如 "3m空头") |
| `retail_syms.json` | 散户流向标的 |

---

## 11. Secrets & Variables(仓库设置)

- **Secrets**:`FINNHUB_API_KEY`、`MASSIVE_API_KEY`、`REDDIT_CLIENT_ID`、`REDDIT_CLIENT_SECRET`
- **Variables**:`MASSIVE_BASE_URL`(Massive 自定义网关地址)
- FRED、Yahoo 免 key。

---

## 12. 运维踩过的坑(重要)

1. **GitHub cron 不可靠**:盘中采集(gex.yml)的定时经常被延迟/静默跳过。盘中 K 线不更新时 → `gh workflow run gex.yml` 手动启动(或交易台「▶ Run to Close」按钮)。
2. **改仓库名**:① 必须改 `assets/shared.js` 的 `REPO`(否则前端 contents API 打旧名→301 跨域 CORS 断→回退到旧 EOD 基线、K线"冻住");② Pages 要重新 `gh workflow run deploy.yml`;③ 相对符号链接不受影响;④ 私有库 `stock-dashboard-private` **不改名**。
3. **ES module 缓存**:前端改动后浏览器可能吃旧缓存 → `Cmd+Shift+R`,或靠部署时的 `cache_bust.sh` `?v=sha` 根治。
4. **两个 gh 账号**:`takkujunjieli`(个人,本仓库)vs `jli-cognitiv`(工作)。个人仓库 push/gh 写操作前先 `gh auth switch --user takkujunjieli`。macOS keychain 可能仍注入旧账号 token 导致 403,可靠 workaround 用显式 header:
   ```bash
   TOKEN=$(gh auth token -u takkujunjieli)
   AUTH=$(printf "x-access-token:%s" "$TOKEN" | base64 | tr -d '\n')
   git -c http.extraheader="Authorization: Basic $AUTH" push origin main
   ```
5. **Massive 走 HTTP 自定义网关**(`MASSIVE_BASE_URL`,仅 HTTP 无 TLS)——已知风险;官方 api.massive.com 对该 key 401。代码有报错脱敏(公开库防 key 泄漏)。
6. **数据时效**:库里 JSON 是快照(盘后/上次采集);要当前价/IV 用 Robinhood 只读 MCP 实时拉。

---

## 13. 常见操作 Cheatsheet

```bash
# 本地起 server
cd ~/personal-projects/ai-dashboard && python3 -m http.server 8000

# 刷新持仓(Claude 侧:调 RH 只读 MCP 归一后)→ 重建本地
python3 scripts/build_portfolio.py            # → portfolio.json + pnl.json(本地)

# 改分并重建(改私有库 build_scorecards.py 后)
python3 scripts/build_scorecards.py           # → 私有库 scorecards/*.csv
cd ~/personal-projects/stock-dashboard-private && git add -A && git commit && git push  # 切 takkujunjieli

# 前端改动上线
git add <files> && git commit && git push     # 切 takkujunjieli
gh workflow run deploy.yml                     # 必须,否则公开站不更新

# 盘中采集(cron 跳过时)
gh workflow run gex.yml
```

---

## 14. 相关文档

- `docs/1-系统构建.md` — 架构/构建待办(早期,部分过时)
- `docs/2-交易策略.md` — 操作周期/指标解读/信号验证
- `docs/3-数据与存储.md` — 数据源/采集节奏/文件布局(早期)
- `docs/adr/` — 架构决策记录
- `docs/strategy-cycle.md`、`docs/backtest-flow-gamma-pilot.md`、`docs/analysis_report_playbook.md`

---
*生成于 2026-09。反映改名(stock-dashboard→ai-dashboard)、双仓库/符号链接、Portfolio、Scorecards、rates 聚合图、统一 tab 栏之后的当前状态。*
