# 短线分析报告 · 生成指引 (Playbook)

复现 `analysis_report_YYYY-MM-DD.md` 的完整步骤。本文件记录字段映射、公式、门槛与话术。

**已固化为脚本**：`scripts/gen_report.py`（本 playbook 的可执行实现）。

```bash
python scripts/gen_report.py                 # → analysis_report_<快照日期>.md
python scripts/gen_report.py --stdout        # 打印不落盘
python scripts/gen_report.py --bucket week   # 选 GEX 到期桶 (默认 0dte)
python scripts/gen_report.py --afterhours    # 头部标注盘后采集
```

本文档是脚本的**规格说明**：改门槛/话术先看这里，两者需保持同步。也可让 Agent 直接照此复现：
> "读 data/research.json 和 data/gex.json，按 docs/analysis_report_playbook.md 生成全 watchlist 短线分析报告。"

---

## 0. 输入与前提

| 文件 | 用途 | 关键字段 |
|---|---|---|
| `data/research.json` | 行情/技术/期权指标 | `updated_at`, `options_source`, `tickers[SYM]` |
| `data/gex.json` | GEX 名义/流量、flip、按行权价墙 | `updated_at`, `tickers[SYM]` |

- **票池**：`research.json.tickers` 的全部 key（当前 22 支），顺序沿用 JSON 出现顺序。
- **数据快照时间**：取 `research.json.updated_at`（报告头写这个 ISO 时间）。若为盘后采集，需在全局前提里标注"盘后读数"。
- **必读前提（每次都写在报告头 blockquote 里）**：
  1. 盘后采集则现价/量为盘后读数，RTH 真值以日线为准；
  2. `gex_daily` 历史不足（<~20 天）→ IV/PCR **自身分位缺失**，无法判断相对高低；
  3. flow-GEX 仅覆盖**单名股**且仅最活跃合约（逐票标覆盖率）；ETF(SPY/QQQ/SOXX)无 flow；
  4. 权利金/PCR 为**活跃度非方向**。

---

## 1. 字段映射（每票）

设 `R = research.json.tickers[SYM]`，`G = gex.json.tickers[SYM]`，`O = R.options`。

### 现价与近端结构（第 1 段）
| 报告项 | 来源 | 备注 |
|---|---|---|
| spot | `G.spot` | 无则回退 `O` 现价 |
| 日线 OHLC | `R.bars_d[-1]` = `[ts,O,H,L,C,vol,vwap]` | 取最后一根 |
| 收于日内位置 | 由 C 相对 (H,L) 计算 | C 在上 1/3→"收高/偏强"；下 1/3→"冲高回落/偏弱"；中间→"震荡" |
| 较前收 % | `(C - bars_d[-2].C)/bars_d[-2].C` | |
| VWAP | `R.vwap` | 现价高/低于 VWAP |
| RSI(D)/RSI(1m) | `R.ind.rsi_d` / `R.ind.rsi_m` | 30–70 记"中性" |
| short vol | `R.short_vol[-1].ratio` | 最新一日 short volume 比 |
| days-to-cover | `R.short.days_to_cover` | |

### Gamma 结构（第 2 段）
选定**到期桶**（默认沿用 CONTEXT 的 0DTE 语义；汇总/情景用累计 `all`，见 §3）。设 `B = G.buckets[bucket]`。
| 报告项 | 来源 |
|---|---|
| net GEX nom | `G.net_gex`（或 `B.net_gex`） |
| net GEX flow + 覆盖率 | `G.flow.net_gex`，覆盖率 `G.flow.coverage`；ETF 无 flow 记 "flow N/A" |
| 上方正墙(阻力/磁吸) | `G.by_strike` 中 strike>spot、`net>0`，按 |net| 降序取前 3 |
| 下方负墙(加速) | `G.by_strike` 中 strike<spot、`net<0`，按 |net| 降序取前 2 |
| ⚠️ ATM 分歧 | 现价 ±~2 档内，`G.by_strike`(名义 net) 与 `G.flow.by_strike` 同一 strike **符号相反** 的行 → 列出并注"该带信 flow" |

墙金额显示为 `net/1e6` 取整 + "M"。

### 预期波动 / 价格分布（第 3 段）
| 报告项 | 公式 / 来源 |
|---|---|
| ATM IV | `O.atm_iv`（小数，×100 显示 %） |
| **次日 ±%** | `σ₁ = atm_iv / √365`（**日历日年化**，已核对：0.96/√365=5.0%） |
| 次日区间 | `spot × (1 ± σ₁)` |
| 到 <expiry>(~Nd) ±% | `σ_N = atm_iv × √(N/365)`，N = 快照到该到期（`O.max_pain_exp` 或最近周五）的日历天数 |
| IV skew RR | `O.skew_rr`（×100）。>0 → put skew·左尾偏肥；<0 → call skew·右尾偏肥；≈0 → flat |
| max pain | `O.max_pain`（日期 `O.max_pain_exp`），并给"现价 vs maxpain %" |
| IV 期限 | `atm_iv → iv_term`（近月 → 远月 ATM IV，×100）。近>远 → backwardation·近端紧张；近<远 → contango·正常 |

### 期权持仓 / 资金（第 4 段）
| 报告项 | 来源 |
|---|---|
| 权利金 C/P、net | `O.call_premium` / `O.put_premium`（÷1e6 显示 M），net=call-put |
| PCR vol | `O.pcr_vol`：<0.7 → call 偏重(活跃度偏多)；>1.3 → put 偏重(活跃度偏空)；否则均衡 |
| 最活跃合约 | `O.top_strikes` 前 5，格式 `strike+side首字母(exp MM-DD)` |
| 固定注脚 | "权利金=活跃度非买卖方向,与 skew 合看" |

### 本周情景 + 数据质量（第 5 段）
- **关键位**：上方阻力 = 最近上方正墙；下方支撑 = maxpain（或最近下方结构）；加速带 = 最近下方负墙。
- **基准情景**：在 [支撑, 阻力] 间震荡/整理；偏多需站上 flip(flow 优先，无则 nom，越界记 "—")；偏空看丢支撑。
- **标注（逐条按触发拼接）**：见 §2 门槛。

---

## 2. 判定门槛与标注规则

- **γ 区制**：现价 > flip → 正γ(稳)；现价 < flip → 负γ(放大)。flip 为 None/远离密集区 → "flip 越界"、区制记 "—"。
- **flip nom vs flow**：nom = `G.flip`（或 `B.flip`）；flow = `G.flow.flip`。二者都显示，情景以 flow 为准。
- **无 IV 历史分位**：只要 `O.*_pct` 为 None（gex_daily 历史不足）→ 恒标 "无 IV 历史分位"。
- **IV 疑失真**：`atm_iv` 明显偏高（经验 >~100%）**且** 本周无财报（`R.earnings_days` 为空或 >~7）→ 标 "ATM IV X% 偏高但本周无财报(earn Nd)→ 疑近月失真,预期振幅需核对原始 IV"。汇总表的"关键提示"列记 `IV疑失真`。
- **flow 覆盖弱**：`G.flow.coverage < ~40%` → 标 "flow 覆盖仅 X% → 方向读数偏弱"，汇总列记 `flow弱`。
- **raw flip 越界**：flip 缺失/现价远离 gamma 密集区 → 标 "raw flip 越界(现价远离 gamma 密集区)"。
- **ETF**：SPY/QQQ/SOXX 无 flow-GEX → 标 "ETF 无 flow-GEX"，汇总列记 `ETF`。

---

## 3. 汇总速览表（报告顶部）

每票一行，列：`票 | spot | flip(nom/flow) | 区制 | 次日±% | maxpain | skew | PCRv | 关键提示`。
- flip 缺失记 "—"；`次日±%` 用 §1 的 σ₁；`skew` = `skew_rr×100` 取整带符号；`PCRv` = `O.pcr_vol`。
- 关键提示 = §2 触发的短标签集合（`flow弱` / `IV疑失真` / `ETF` / `—`）。

---

## 4. 组装顺序（Agent 执行步骤）

1. 读 `data/research.json`、`data/gex.json`；取 `updated_at` 与票池。
2. 逐票按 §1 计算全部派生量（收盘位置、涨跌幅、σ₁/σ_N、墙、ATM 分歧、区制、各标注）。
3. 先写报告头（快照时间 + §0 全局前提 blockquote）。
4. 写 §3 汇总速览表。
5. 逐票写五段结构（引言行 `> spot… · flip… · 区制 · maxpain · ATM IV · PCR…` + 五个编号段），票间用 `---` 分隔。
6. 全篇为**指标解读，非投资建议**——不给具体买卖点位/仓位。
7. 存为 `analysis_report_<快照日期>.md`（仓库根目录，untracked）。

---

## 5. 关键公式速查

```
σ_daily(次日)   = atm_iv / sqrt(365)          # 日历日年化，已用 SPY/QQQ/TSLA/SNDK 校验
σ_N(到期)       = atm_iv * sqrt(N / 365)      # N = 快照→到期 的日历天数
区间            = spot * (1 ± σ)
net_premium     = call_premium - put_premium
收盘位置        = (C - L) / (H - L)            # >2/3 强, <1/3 弱, 其余震荡
γ 区制          = spot > flip ? 正γ(稳) : 负γ(放大)
```

> 校准 TODO（见 TODO.md）：IV 失真门槛、flow 覆盖门槛目前为经验值，待回测校准；maxpain pin score 已进 gex 流水，可替代部分人工"磁吸"判断。
