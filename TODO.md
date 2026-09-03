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

## 3. ✅ flow 采集节奏(2026-07-26 重排)【数据新鲜度】
- **采样版 Real**:盘中**每轮**跑(快照 last_trade vs NBBO,零额外 API,全链)——修正 nominal 符号的主力,每轮实时刷新。(注:旧 `SKIP_FLOW` 是死变量,从未被读,已删。)
- **精确层(top-N 逐笔 Lee-Ready)**:每日 **2 次**且都跑在"tape 真含当日"的时点——
  - 盘中 **ET 12:00 后第一轮**(`collect_session` 内,`PRECISE_HOUR` 可调),让 top-N 符号反映今天;
  - 收盘后 **~15min**(`update.yml` cron `15 21 UTC`),全天完整 tape,喂 EOD/gex_daily/`oi_panel`。
  - **废掉盘前那次**(9:00 ET 时今天还没成交,只会把昨天符号钉一天)。
- tape 抓取加 `timestamp.gte=当日`(修 `order=asc` 拿最旧、活跃合约漏掉今天的 bug)。

## 4. git 体积 【运维,长期观察】
每轮提交一次 `data/*.json`,盘中 ~100s/轮 → 一天上百次提交,`.git` 持续增长。
**实测(2026-07-14)**:.git 共 34MB / 8 天 / 271 次提交 ≈ 每次提交打包后仅 +~125KB(delta 压缩有效);
但提速后频率涨到 ~150-200 次/交易日 → 预计 **~20-25 MB/天(~0.6 GB/月)**。快照(data/ 目录)≈ 6.2MB 恒定,大头 research.json 4.2MB(K线为主)、oi_prev 1.2MB、gex 0.64MB。
**最便宜的缓解(优先做这个)**:裁剪 `research.json` 的 K线历史——`fetch_research.py` 里 `BAR_KEEP=800`、bars_1m 取 2 天/bars_5m 取 5-7 天;可降到 bars_1m 1 天、bars_5m 2-3 天。文件小了每次 delta 也小。
**更彻底**:data 改 orphan 分支 + force-push 只留最新(无历史);或定期 `git gc`/重写历史。注意 `gex_daily.json` 自身已含 250 天历史(不靠 git 历史),裁 git 历史不影响回测。

## 5. 真·秒级实时(可选,大改) 【架构】
要秒级而非"每轮一跳",需用 **Massive 期权/股票 websocket 流**(订阅制,非 calls/min)。与当前"GitHub Actions 批量 → 静态 JSON → 前端轮询"架构不兼容,需常驻进程(自建小服务/Vercel 等)。仅在对实时性有强需求时评估。

## 6. ✅ ATM IV 口径去偏(2026-07-26,PR #60):≥20 DTE 常数期限 + OI 加权 + 脏报价过滤 【数据质量 / 估计量去偏】
**已完成**:`summarize_options` 主 `atm_iv` 改**方差插值到 ≥IV_MIN_DTE(默认20)常数期限** + ATM±3% **OI 加权** + `_clean_iv` **脏报价过滤**;新增 `atm_iv_front`(最近到期原值)/`atm_iv_dte`(口径透明);skew 用最接近阈值的真实到期;`by_expiry` 每档 IV 同口径去偏。前端 ATM IV tile 显示期限 + front 背离提示;`gex_daily` 存 front/dte。**口径已变,历史分位从改动日重累积**。以下为原始记录:
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
- 优化方向:
  - ✅ **(1)(2) 已做(PR #62)**:门改用 `near_money_gamma`(现价 ±2% 各行权价 net GEX 的**净/毛倾斜** z∈[-1,1],`PIN_GATE_SLOPE=3`),替代旧的 flip 距离 / 全链 net 符号;`flip=None` 不再退化成 ±1(近价无 OI 才退回全链符号)。烟测:QQQ 式(近价净正、全链 net 负)94 分(旧≈十几);真近价净负 gamma → 5 分。
  - ⬜ **(3) 多快照平滑**(近 N 轮门值均值降噪):需跨轮状态,留后续(本 PR 未做)。

## 8. flow-GEX 预测力 pilot(预注册)+ 前向累积 【signal research;累积中】
**目标**:验证 flow-GEX(期权流的 gamma 区制)对短周期收益的预测力,再决定是否策略化。协议见 [docs/backtest-flow-gamma-pilot.md](docs/backtest-flow-gamma-pilot.md)(**预注册**:假设/口径先于结果冻结)。

**已完成**:
- **历史重建回测**([scripts/backtest_flow_gamma.py](scripts/backtest_flow_gamma.py) + `flowbt.yml`):一周数据只能测"净签名期权流方向"(历史 gamma/OI 无法回溯)。首轮 **H1 未通过且方向相反**(判定量裸流 −0.124/−0.250、gamma 加权 −0.149/−0.270,逐日 0-1/5)。gamma 加权诊断**排除了"丢 gamma"病因** → 反向对 gamma 加权稳健。
- **前向记录器**([fetch_research.py](scripts/fetch_research.py) 写 `data/flow_history.json`,跨天累积不清零留 60 天):每轮每票记**真实 flow-GEX 净值(带 gamma×OI)+ 名义 net + call/put OI + spot**。评测 [scripts/eval_flow_history.py](scripts/eval_flow_history.py) 用真 flow-GEX 跑同一套预注册检验。

**待办(这条的"完成"取决于时间累积)**:
1. **攒样本**:让 `flow_history.json` 累积 **≥30-40 交易日**(≈6-8 周)、跨不同 regime。
2. **区分开/平仓**(裸流反向的头号嫌疑)——**ΔOI 分层诊断已实现**(`eval_flow_history.py`:用记录的 `co/po` 日间差判净开/平仓,在"仅开仓日 ΔOI>0"子集重跑;历史 OI 拿不到故只能前向)。待累积几天 OI 变化后出结果:若开仓子集判定量比全样本明显更正 → 坐实开/平仓是元凶。
3. **下结论**:跑 `eval_flow_history.py` + **block-bootstrap-by-day 显著性 + 多重检验校正**,给"可信/丢弃"。
4. **只有信号通过**才进入策略化。
**方法论可复用**:预注册 + 前视纪律 + 分层对照 + 诚实功效声明,套到任何后续指标。

## 12. EOD 全链面板 → ΔOI×vol 开/平仓四象限 【signal research;累积中,#8 的前向解法】
**动机**:把 flow-GEX 的开/平仓污染(见 [3-数据与存储](docs/3-数据与存储.md) A 段、#8 待办 2)从"⚪ 固有无解"降级为可解。dealer gamma 库存变化 = Σ sign×gamma×**ΔOI**,而采样主动净流 ≠ ΔOI;**ΔOI 就是 dealer 净库存变化本身**,明天减今天即可,不需要 open/close 标记。

**已完成(PR #59)**:[oi_flow_rows](scripts/fetch_research.py) 扩成 10 列全链面板,每日 EOD 落 `data/oi_panel/{date}.parquet`(近价≤14DTE、按日分区、zstd、留 500 天,零额外 API)。列:`sym,exp,strike,cp,oi,vol,gamma,delta,iv,mid,active_net`。关键新增 `vol` 用于对账 ΔOI。

**待办(取决于时间累积)**:
1. **攒样本**:让 `oi_panel/` 累积 **≥15-20 交易日**(跨到期周);OI 结算 T+1,跨日对齐留离线。
2. **离线四象限脚本**:跨日读 parquet 算 ΔOI,对账当日 `vol`——ΔOI 同号≈vol → 净开仓(dealer 反向建库存);vol≫\|ΔOI\| → 日内对倒/平仓(采样主动净流假信号);ΔOI<0 → 净平仓。产出每票每档"真持仓方向 × gamma"序列。
3. **回测**:用 #10 的 `strategy_*` 框架跑 gamma 库存方向的延续/反转预测力,对比被开/平仓污染的采样版 pilot(#8,预测力为负)。
4. **下结论**:若真持仓口径预测力显著转正/成立 → 摘掉 data doc A 段 ⚪ 标记;否则记录为"结构参考,非信号"。

## 9. ✅ AVWAP 手动多锚(点击锚定)【前端 / 交互】(2026-08-02)
**已完成**:废掉旧的"全局极值锚"(Swing Low/High/Range Start,随周期漂移、被插针误锚)。改为**手动点击锚定**:
- Overlays 栏 `AVWAP: [点击锚定] [清除]`;开启后点图上任一 bar → 从那时刻起画一条锚定 VWAP;点已有锚附近 → 删。
- **可留多条**(颜色循环),聚拢处 = 强支撑/压力确认;**按时间戳锚**(存 epoch),切周期自动在当前粒度重算、跨周期一致;锚落窗口外则不画。
- 锚点**按票持久**(localStorage `wbAvwap`);hover 显示 `AVWAP <锚时刻> + 当前均价`。
**未做(以后可选)**:会话锚/事件锚/真 swing 枢轴的"一键锚"(手动点选已覆盖主要需求)。

## 11. 历史 K线拆股校正(splits adjust) 【数据质量】
**现状**:回填/累积历史日线 OHLC 未处理拆股;`/v3/reference/splits`(实测 200,字段 `execution_date/split_from/split_to/ticker`)可用。拆股当日价格会**静默跳变**(如 2:1 → 前一日 close ≈ 后一日 2×),污染 RV/EWMA-ADV/回测收益序列。
**做法**:低频层(与单票详情同 TTL)拉各票 splits;对 `bars_d` 在 `execution_date` 之前的价格乘 `split_from/split_to`(成交量反向),或在算 RV/回测时按调整因子归一。watchlist 短期内很少拆股,优先级低,但一旦发生且未处理会造成明显假信号。

## 10. ✅ 回测框架完成(#46-#52,2026-07-25)—— 剩数据积累 + 可选机构流信号 【策略产出】
**状态**:框架 7 个 PR 全部合并部署。**能力齐全**;可信 OOS 结论仍需 ~30-40 交易日样本。用法见文末「回测框架用法」。
**来源**:`~/personal-projects/Playground-master`(Institutional Flow Monitor)。同数据源(Massive)。
**为什么值得**:两边的"backtest"互补而非重复——
- 本项目现有 backtest(`backtest_flow_gamma.py` / pilot)= **信号研究**(IC/条件自相关/预注册):测"指标**有没有预测力**"。
- Playground 的 `run_backtest` = **交易模拟器**(TP/SL/最大持仓/权益曲线/胜率/回撤):测"按信号做策略**能不能赚钱**"。
本项目**缺后半段**,这正是"策略产出"页要补的真空。
**红线(必带)**:`run_grid_search` 是过拟合机器(324 组挑 Return/(DD+1) 最优),小样本上必出虚假最优 → **必须绑 OOS/walk-forward + 预注册**,复用现有纪律([backtest-flow-gamma-pilot.md](docs/backtest-flow-gamma-pilot.md))。
**不搬**:交互式 server dashboard(与静态 Pages 架构冲突)、cache 系统(已有数据管线)、QC 算法。
**依赖注意**:Playground 用 pandas/numpy/pandas_ta;本项目刻意精简。**PR 1 优先考虑用纯 Python 重写引擎**(避免把 pandas 拖进精简栈);若确需 pandas,只给离线脚本加、不进前端。

**PR 拆分(每个独立可上线,tracer-bullet 纵切):**
**重排(2026-07-25):目标是"完整可信的回测框架本身",信号只是可插拔输入(原 Playground 信号降级为以后随手插的候选)。**
一个完整框架要有:事件循环+持仓 · 可插拔信号接口 · **真 OHLCV 价格对齐** · **无前视** · **成本/滑点** · **基准(buy-hold)+随机 null** · 完整指标(Sharpe/Sortino/profit factor/暴露度/CAGR) · **样本内外 + walk-forward** · 仅在 OOS 评估的寻优 · 多票汇总 · 可复现。

- ✅ **PR1**(#46)引擎(信号无关,纯 Python):TP/SL/max_holding、权益曲线、win_rate/收益/回撤。
- ✅ **PR2**(#47)接真信号:flow-GEX 喂引擎 → `data/strategy_bt.json`。(注:用了 flow_history 的每轮 spot,PR5 会换真 bars)
- ✅ **PR3**(#48)静态页 `strategy.html` + 采集时 producer hook。
- ✅ **PR4**(#49)框架核心:引擎 `cost_bps` + `entry_lag`(无前视);`strategy_metrics.py`(Sharpe/Sortino/PF/payoff/暴露度/CAGR);`strategy_signals.py` 基准 buy-and-hold + 随机 null + 构造器(sign/threshold/ma_cross)。
- ✅ **PR5**(#50)信号层:`SIGNALS` 注册表 + `make_signals`(彻底解耦);`strategy_run.py` 从 `gex_daily` 建真日线上下文(price=spot,特征按日对齐)。
- ✅ **PR6**(#51)walk-forward/OOS + 寻优:`strategy_walkforward.py` `grid_search`(样本内选参)+ `walk_forward`(train 选参→test OOS→串联)。
- ✅ **PR7**(#52)报告:strategy.html 渲染 metrics + Buy&Hold 叠加 + OOS 区(每折训练选参);`strategy_run` 落 `oos`/`benchmark`。

**剩下(非阻塞):**
- ⬜ **数据积累**:等 `gex_daily` 攒到 ~30-40 交易日,walk-forward 才出可信折(在此之前页面显示"样本不足")。
- ⬜ **(可选)机构流信号**:用注册表把 `InstitutionalFlowAnalyzer`(Playground)插成候选,**先过 IC 研究**再进策略。
- ⬜ **(可选)多信号/多票批量 + 专用 workflow**:目前 producer hook 每轮跑单信号单票;要横向对比需扩批量。

---
## 回测框架用法(scripts/strategy_*.py)
**文件**:`strategy_backtest.py`(引擎)· `strategy_metrics.py`(指标)· `strategy_signals.py`(注册表+基准)· `strategy_walkforward.py`(OOS/寻优)· `strategy_run.py`(管线,读 gex_daily → 写 data/strategy_bt.json)。全纯 stdlib、只读、无 key。

**跑一次(离线,本机)**:
```
git fetch origin data && git show origin/data:data/gex_daily.json > data/gex_daily.json
SIG=flow_sign python3 scripts/strategy_run.py        # 换 SIG 即换信号
```
env:`SYM`(默认点数最多的票)· `SIG`(见下)· `BT_TP`/`BT_SL`/`BT_HOLD` · `WF_TRAIN`/`WF_TEST`。
**内置信号**:`flow_sign` `nom_sign` `pcr_contra` `ma_cross` `random`(null 对照)。
**加新信号**:在 `strategy_signals.SIGNALS` 加一条 `{"名字": {"desc":..., "fn": lambda c: ...}}`,`c` = {prices, feat{字段:序列}}。
**看结果**:strategy.html(采集会自动产 `strategy_bt.json`);或本机看 `data/strategy_bt.json`。
**判有没有 edge**:比 `random`(null)和 `benchmark`(Buy&Hold);**只信 `oos` 块**(walk-forward),别信样本内 total_return。
**直接调库**:`from strategy_backtest import run_backtest` / `from strategy_walkforward import walk_forward`。自检:`python3 scripts/strategy_*.py`。

## 13. 单票轻量 1m 端点 → VWAP/价格 ~20s 刷新 【数据新鲜度 / 前端】
**动机**:现在 `bars_intraday.json` 把所有票×3周期塞一个 ~8.8MB 文件,前端 `BARS_MIN_MS=120s` 最多 2 分钟才拉一次 → 即便盘中 20s 轮询+PAT,VWAP 也 2 分钟才动一次。
**做法**:采集侧额外为"当前重点票"写一份**按单票、只含最近 N 根 1m** 的轻量文件(几 KB),前端查看某票时单独高频拉它 → VWAP/价格 ~20s 更新,不必拖 8.8MB。可与 GEX 的 options_watchlist(≤5)复用"重点票"集。
**关联**:VWAP 计算已统一到 1m 口径(2026-08,vwap1mSeries/vwapSampledTo);此项解决的是"多快拿到最新 1m",与 #5(websocket 秒级)是更轻的中间档。
