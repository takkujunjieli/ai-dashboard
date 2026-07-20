# CONTEXT

短线研究系统的领域语言。代码、文档、讨论中统一使用这些术语。

## 术语表

### 信息页 (Info Page)
`index.html`。**阅读型**内容的聚合:主页(行情条/EPS surprise/分析师评级)、新闻(宏观 RSS/公司新闻+情绪标签/财报日历)、社区(Reddit 按热度/X/YouTube)。不承载交互式数据分析。

### 交易页 (Trading Page)
`trading.html`。**交互型**数据工作台:个股(K线/技术指标/做空数据)、期权(链上指标/GEX)、采集控制面板。零构建,图表库(TradingView lightweight-charts)经 CDN 引入。与信息页互跳。

### 工作台 (Workbench)
交易页的布局范式:**单票聚焦**。顶部 watchlist 迷你行情卡兼作切票器,选中票占据全页——K线主图(缩放/十字线/EMA9/21与VWAP叠加)+成交量副图+盘中净GEX副图(共享时间轴),右侧行权价梯,下方详细期权面板。

### 行权价梯 (Strike Ladder)
与 K 线主图**共享价格轴**的水平柱状图,每个行权价一行,可在 GEX/OI/成交量间切换。现价与 gamma 墙/OI 墙直接对齐,是交易页区别于嵌入式卡片的核心联动。

### GEX 到期桶 (GEX Expiry Bucket)
GEX 梯/净GEX/flip 按到期日分桶,**累计**口径(0dte ⊂ week ⊂ 2wk ⊂ all,对应 ≤0/7/14/45 天)。交易页默认 **0DTE**——决定当日盘中钉价的是近月 gamma,远月汇总会稀释信号。当选中桶为空(如周末无当日到期合约)时前端自动回退到最近的非空桶并标注。后端 `compute_gex` 产出全部桶,`gex_history` 每点存各桶净值供 sparkline 联动。

### GEX 口径 (GEX Caliber):Nominal (index) vs Real (实测,sampled)
两者**底层都是 gamma×OI(存量),唯一区别是每张合约的 dealer 符号怎么定**。UI 显示 **Nominal (index) / Real (sampled)**(内部字段/开关仍叫 `flow`,未改以免动数据格式)。
- **为什么不叫「Flow」**:"flow" 有二义——(A) 流量(成交量),(B) 用成交流向给存量定号。此处是 (B),GEX **仍是存量、不是流量**,故用 "Real(实测符号)" 对 "Nominal(假设符号)",避免误解成"成交量 GEX"。
- **Nominal (index)**:假设 call 记正、put 记负(dealer 多 call 空 put)。每轮算、覆盖全链、零额外 API。标 **(index)** 是因为这套假设**对指数(SPX/SPY)校准合理**(机构买 put/备兑 call 主导),**对单名股常错**(散户买 call → dealer 反而空 call)。
- **Real (sampled)**:用真实成交方向反推 dealer 符号(客户净买→dealer 空→负)。两层:①**采样版**(每轮用 snapshot 的 last_trade vs NBBO 判向、按成交量增量累积,零额外 API、全链)②**精确层**(top-N 高 gamma 合约逐笔 Lee-Ready,`FLOW_PRECISE` 2×/天)覆盖采样符号。存于 gex.json 的 `tickers[sym].flow`(`method`=sampled/sampled+precise、`coverage`、`ambiguity`)。只对**单名股**(`FLOW_SKIP` 排除 ETF);缺失时退回 Nominal 并标注。是**估计**(Lee-Ready ~80%、开/平仓不分、coverage<100%)。

### 净签名期权流 (Net Signed Options Flow) — 区别于 flow-GEX
Lee-Ready(成交价对成交时刻 NBBO)判每笔主动买卖,size 加权,汇总近价 ≤14DTE 的**客户净买卖方向**。
- 它是 **flow-GEX 的方向内核,但不是 flow-GEX**:flow-GEX = Σ(dealer符号 × **gamma×OI**),而历史 gamma/OI 快照专属、**无法回溯重建**,故历史回测只能用这个"去掉 gamma 权重"的版本。
- **符号语义看用途**:预测 **gamma 区制/波动延续**时,客户买 call 或 put **都**→dealer 空 gamma(不分多空);预测**涨跌方向**时才需 call/put 多空极性(买call+/卖call−/买put−/卖put+)。两者不可混用同一净值。
- **已知误差**:①丢 gamma 权重→被高量低 gamma 的便宜虚值合约带偏;②开仓 vs 平仓无法区分(历史无每日 OI delta);③Lee-Ready 残差 ~10-20%;④size≠金额。回测结论只能推"期权流方向/gamma 区制"的预测力,**不能直接当 flow-GEX 的结论**。

### 周期集合
K 线周期固定四档:1m / 5m / 15m / 日线。15m 由 1m 客户端聚合;日线单独抓取(6 个月)。

### 刷新策略
交易页始终自动轮询 GitHub contents API,无手动刷新依赖:填了 PAT(与采集控制共用)→ 60 秒;
未填 → 5 分钟(3 文件 × 12 次/时 = 36 次,低于匿名 60 次/时限额)。

### watchlist / deep(标的配置)
唯一来源是 `config/tickers.json`(旧 `watchlist.yml` 仅作回退),**由交易台「标的配置」面板在 UI 编辑**(PAT 经 GitHub contents API 写回,PAT 需含 Contents 读写):
- `watchlist` — 全集:行情条、快照、财报日历、公司新闻、分析师评级。
- `deep` — 深度子集:分钟K线/技术指标/做空/期权链/GEX,是交易页切票器的对象。缺省等于 watchlist;SPY/QQQ 期权重,可精简。

### 调用量约束
期权额度仅 50/分钟。降负载:①期权链服务端只取现价 ±20% 行权价 + ≤45 天(`OPT_FETCH_BAND`);②RSI/EMA 本地从 K 线算,不走计费的 indicators 端点;③滚动采集按 `deep` 分批(BATCH=3)提交,单批期权调用远低于额度。

### 滚动采集 (Rolling Collection,2026-07-12 起)
交易日 ET 9:30-16:00 自动运行的采集会话(cron 启动,无需手动):watchlist 按 3 只一批轮转,
每批 = 快照+1m/5m K线+期权链+GEX,抓完即提交;低频层(指标/short/新闻/日线)每小时刷一次。
额度按 REST 500/min、期权 50/min 设计(期权调用 1.5s 间隔留余量)。一轮 16 只约 5-7 分钟。
交易页控制面板可手动补启「至收盘会话」或「单轮采集」(测试/盘后补数据)。

### 快照 (Snapshot)
一次采集循环中写入 data/*.json 的当次数据。盘中序列(如 GEX 走势、OI 变化)由连续快照累积而成。

## 页面内容边界(2026-07-10 决定)

| 信息页 | 交易页 |
|---|---|
| 主页(行情条+EPS+评级)、新闻、社区、财报日历 | 个股(K线/指标/做空)、期权(链指标/GEX)、采集控制 |

行情条两页都有;财报日历/EPS/评级虽是 API 数据,但属阅读型,归信息页。
