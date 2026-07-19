# TODO(待办,按优先级)

## 1. 并发预取,把采集轮次从 ~100s 砍到 ~15-25s 【性能,主杠杆】✅ 已做(2026-07-18)
**已完成**:`_prefetch_ticker` 线程池两阶段(并发抓 → 串行处理),`compute_flow_precise` top-N 也并发。实测并发对期权链 5.5×;盘中 live 延迟下预计稳态轮 ~20-40s(周末高延迟测得 ~64-190s,不可比)。真实提速待盘中确认。以下为原始记录:

**背景**:盘中滚动一轮 ~100s(20 只票),大头是**期权链分页**——20 只 × ~6 页 ≈ 120 次带载荷请求,目前**顺序**打(`fetch_research.py` 里 `mget` 逐次 + 0.08s 间隔)。
**已验证前提**:网关对并发无限流(`rate_probe` 测过 200 并发 / 240 混合,零 429;50/min 是期权 websocket 上限,与纯 REST 无关)。
**做法**:在 `fetch_research.main()` 里,循环前用线程池(`ThreadPoolExecutor`, ~10 workers)**并发预取**每只票的 option chain(`options_massive`)和 K 线(`fetch_bars`/雅虎),存进 dict;主循环改为从 dict 读,不再逐个网络调用。注意:
- 链分页 `next_url` 是顺序的(拿到上一页才知下一页),并发只能到"票"级别,不能到"页"级别——但票级并发已足够(120 次 → ~12 次深度)。
- 并发路径里去掉 `OPT_SLEEP`/`SLEEP`(那是顺序礼貌间隔);保留 429 重试兜底。
- `requests` 每次调用独立、线程安全;但 `out["errors"]`、`oi_next`(OI 变化存档)等共享结构要么加锁,要么每票返回后单线程合并。
**预期**:一轮 ~100s → ~15-25s,盘中价格/GEX/VWAP 刷新更勤。

## 2. `deep` 组的新含义 【设计,待定】
现状:所有 ticker 都进"普通组"、全量拿深度数据(K线/期权/GEX/指标);`config/tickers.json` 的 `deep` 字段**保留但后端已不作门槛**(`fetch_research.main` 用 watchlist 全量)。交易台迷你卡上的 D/Q 开关目前对后端是 no-op。
**待定**:重新定义 deep 用途(候选:更高频刷新的一小撮"重点盯盘"票 / 开启逐笔流量分类的票 / 更长历史或更多指标的票)。定了之后再决定 D/Q 开关和后端门槛怎么接。

## 3. 流量分类(flow)目前只在每日 2 次的 update.yml 跑 【数据新鲜度,视需要】
盘中滚动已 `SKIP_FLOW=1` 跳过(否则每轮被 ~640 次逐笔请求阻塞几分钟)。flow/OI 本就日更,2 次/天够用。
**若要盘中 flow**:需把它拆成独立的低频并行任务(单独 workflow 或并发预取),只更新 `gex.json` 的 `.flow` 字段,不阻塞主循环。

## 4. git 体积 【运维,长期观察】
每轮提交一次 `data/*.json`,盘中 ~100s/轮 → 一天上百次提交,`.git` 持续增长。
**实测(2026-07-14)**:.git 共 34MB / 8 天 / 271 次提交 ≈ 每次提交打包后仅 +~125KB(delta 压缩有效);
但提速后频率涨到 ~150-200 次/交易日 → 预计 **~20-25 MB/天(~0.6 GB/月)**。快照(data/ 目录)≈ 6.2MB 恒定,大头 research.json 4.2MB(K线为主)、oi_prev 1.2MB、gex 0.64MB。
**最便宜的缓解(优先做这个)**:裁剪 `research.json` 的 K线历史——`fetch_research.py` 里 `BAR_KEEP=800`、bars_1m 取 2 天/bars_5m 取 5-7 天;可降到 bars_1m 1 天、bars_5m 2-3 天。文件小了每次 delta 也小。
**更彻底**:data 改 orphan 分支 + force-push 只留最新(无历史);或定期 `git gc`/重写历史。注意 `gex_daily.json` 自身已含 250 天历史(不靠 git 历史),裁 git 历史不影响回测。

## 5. 真·秒级实时(可选,大改) 【架构】
要秒级而非"每轮一跳",需用 **Massive 期权/股票 websocket 流**(订阅制,非 calls/min)。与当前"GitHub Actions 批量 → 静态 JSON → 前端轮询"架构不兼容,需常驻进程(自建小服务/Vercel 等)。仅在对实时性有强需求时评估。

## 6. ATM IV 口径去偏:改用 ≥20 DTE 常数期限 + OI 加权 + 脏报价过滤 【数据质量 / 估计量去偏(estimator debiasing)】
**工作类型**:数据质量修复 · 估计量去偏(不是新功能,是给现有指标做**偏差校正**)。
**根因(为何"脏")**:`summarize_options` 的 `atm_iv` 建在**最近到期**上,叠加三重偏差 —
- **近月 vega 塌缩**:σ≈price/(0.4·S·√T),T→0 时分母趋零,报价噪声被 ~1/√T 放大(1DTE 比 30DTE 噪声 ~5.5×);
- **市场微观结构噪声(microstructure noise)**:近月/清淡合约 bid-ask 宽,且用 `day.vwap/close`(陈旧成交价,非实时 mid);
- **薄样本聚合偏差**:ATM ±3% 内**简单平均**,临期常只剩 1–2 张,单张薄合约主导。
**症状(实测 2026-07-15)**:AMD 盘后 ATM IV **96%** → 盘中 **43%**;`iv_vs_qqq` 从虚高 **3.56×** 回落到合理 **1.42×**。skew/term/vrp/expected-move 全建在这个 IV 上,一并被污染。
**做法**:
1. 主 `atm_iv` 改选 **DTE ≥ 20 的最近一档**(或在夹住 20/30 DTE 的两档间插值到常数期限),取 ATM ±3% 内合约的 **OI 加权** IV(`iv=None` 剔除、`oi=0` 自然零权重);
2. `iv_skew` / `iv_term` 切到同一更稳的到期基准;
3. **保留最近到期的 IV 单列**(如 `atm_iv_front`),供对比近月溢价/失真;
4. 视需要调大 `MAX_EXPIRATIONS`,让 20 DTE 那档也进 `by_expiry` 表(否则算得到、表里看不到)。
**数据可用性(已确认)**:`MAX_DTE=45` 已抓到 20 DTE,每合约带 `open_interest`+`implied_volatility`;周期权密集票(AMD/TSLA/MU)的 20 DTE **在原始 `contracts` 里**(`by_expiry` 被 `MAX_EXPIRATIONS=6` 截断只是不展示,`summarize_options` 计算不受影响);CRWD 类月度密集票直接可见 16/23/30 DTE 带 OI。
**影响面**:`atm_iv` / `atm_iv_pct` / `iv_skew` / `iv_term` / `vrp` / `iv_vs_qqq` 及前端预期振幅 —— 改口径后历史分位是**新口径的序列**(旧 `gex_daily` 里的近月 IV 与新值不可直接比,分位需重新从改动日起累积)。

## 7. Max Pain pin score 的回测校准 + gamma 门质量优化 【模型校准 / 数据质量】
**背景**:已上线 `maxpain_pin`(0–100,判断某个 max pain 该不该当"价格磁吸目标";乘法门=gamma,余=f_dist/f_time/f_vol/f_oi 加权几何平均)。权重(0.35/0.25/0.25/0.15)与阈值(RV 0.6、%ADV 1.5、门 logistic 斜率 1.5)目前是**拍的合理值,未拟合**。两个后续问题:

**7a. 回测校准(把启发式变成有据分数)**
- `gex_daily` 每日存了 `maxpain_pin` + `spot` + `max_pain`(及 flip/net/iv 等)。攒够跨越若干到期日后,回测:**到期日实际收盘 vs 当时 max pain 的距离**,按分数分桶看命中率(高分组是否真的更贴近 max pain)。
- 用命中率反推/拟合权重与阈值(如逻辑回归:P(|结算−maxpain|<x%) ~ 各因子),把主观权重换成数据权重。
- 产出:校准后的权重表 + 分档阈值(现在暂用 <20 噪声 / 20–45 弱 / >45 目标)。

**7b. gamma 门的质量问题(当前最大误差源)**
- 门几乎主导总分,但它依赖 `flip` / `net_gex` 的**符号质量**:
  - **ETF 的 `flip=None`**(SPY/QQQ/SOXX 无 flow,且 flip 常越界)→ 现在退化成用 `net_gex` 符号(±1),很粗。实测 QQQ 明明 max pain 贴现价、0DTE、低波动,却因快照期 `net_gex` 为负被门摁到 17 —— 疑似**假门**。
  - `net_gex` 单快照有噪声,符号可能翻。
- 优化方向:(1) 门改用**近价窗口的净 gamma**(spot ±1–2% 累计),而非全链 `net_gex` 符号;(2) 对 `flip=None` 用**平滑的近价 gamma 斜率**替代 ±1 硬兜底;(3) 门值做**多快照平滑**(近 N 轮均值)降噪。
- 验证:重跑 QQQ/SPY 这类"应高分却被门压低"的样本,确认修正后落回合理档。

## 8. flow-GEX 预测力 pilot(预注册)+ 前向累积 【signal research;累积中】
**目标**:验证 flow-GEX(期权流的 gamma 区制)对短周期收益的预测力,再决定是否策略化。协议见 [docs/backtest-flow-gamma-pilot.md](docs/backtest-flow-gamma-pilot.md)(**预注册**:假设/口径先于结果冻结)。

**已完成**:
- **历史重建回测**([scripts/backtest_flow_gamma.py](scripts/backtest_flow_gamma.py) + `flowbt.yml`):一周数据只能测"净签名期权流方向"(历史 gamma/OI 无法回溯)。首轮 **H1 未通过且方向相反**(判定量裸流 −0.124/−0.250、gamma 加权 −0.149/−0.270,逐日 0-1/5)。gamma 加权诊断**排除了"丢 gamma"病因** → 反向对 gamma 加权稳健。
- **前向记录器**([fetch_research.py](scripts/fetch_research.py) 写 `data/flow_history.json`,跨天累积不清零留 60 天):每轮每票记**真实 flow-GEX 净值(带 gamma×OI)+ 名义 net + call/put OI + spot**。评测 [scripts/eval_flow_history.py](scripts/eval_flow_history.py) 用真 flow-GEX 跑同一套预注册检验。

**待办(这条的"完成"取决于时间累积)**:
1. **攒样本**:让 `flow_history.json` 累积 **≥30-40 交易日**(≈6-8 周)、跨不同 regime。
2. **区分开/平仓**(裸流反向的头号嫌疑):用记录的 `co/po` 日间差判断净流是**开仓**(OI 增)还是**平仓**(OI 减),只保留开仓流做 dealer gamma 推断。
3. **下结论**:跑 `eval_flow_history.py` + **block-bootstrap-by-day 显著性 + 多重检验校正**,给"可信/丢弃"。
4. **只有信号通过**才进入策略化。
**方法论可复用**:预注册 + 前视纪律 + 分层对照 + 诚实功效声明,套到任何后续指标。
