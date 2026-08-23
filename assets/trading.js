/* 交易台 — 单票工作台:K线主图 + 共享价格轴行权价梯 + 期权面板 + 采集控制
   图表库: TradingView lightweight-charts v4(CDN,全局 LightweightCharts) */
import {
  $, esc, fmtDT, fmtMoney, fmtNum, REPO, loadJSON, loadFreshJSON, getPat, setPat, ghHeaders,
} from "./shared.js";

const LWC = window.LightweightCharts;
const ET = "America/New_York";

let RESEARCH = null, GEX = null, GEXH = null, BARS = null, WEEK = null, PORTFOLIO = null, PNL = null, SCORES = null;
let pfFilter = null;          // Portfolio 饼图选中的 sym → 交易明细按它 filter
let pfAccount = null;         // Portfolio 选中的账户 id(null=全部账户)
let pfTxPage = 0;             // Portfolio 交易明细当前页(0 起,每页 PF_TX_PAGE 条)
let pfPnlWin = "ytd";         // Portfolio 盈亏诊断窗口:ytd / 3m / 1m
const PF_MIN_VALUE = 1000;    // 饼图只显示市值 ≥ 此的持仓
const PF_TX_PAGE = 20;        // 交易明细每页条数
let CFG = { watchlist: [], deep: [] };  // 标的分组,来自 config/tickers.json,卡片开关就地编辑
let SYM = localStorage.getItem("wbSym") || null;
let TF = localStorage.getItem("wbTf") || "5m";
let ladderMode = "gex";
let ladderDay = null;   // 本周历史 GEX 快照的选中日期(null=最新/Live);GEX 梯用当周到期结构
let gexBucket = localStorage.getItem("wbGexBucket") || "near";  // 单到期=exp 日期串 · "near"=最近 · "all"=≤30d 聚合
if (["0dte", "week", "2wk"].includes(gexBucket)) gexBucket = "near";  // 迁移旧的累计桶选择
let gexCaliber = localStorage.getItem("wbGexCaliber") || "nominal";  // 名义 / 流量
const GEX_BUCKET_ORDER = ["0dte", "week", "2wk", "all"];  // gex_history sparkline 仍按累计桶存
const GEX_BUCKET_LABEL = { "0dte": "0DTE", week: "This Week", "2wk": "≤14d", all: "≤30d" };  // 累计桶名(sparkline 用)
// 单到期 dte → gex_history 累计桶(历史序列只有累计桶,到期日每天滚动无法建时序)
const expToHistBucket = (dte) => dte == null ? "all" : dte <= 0 ? "0dte" : dte <= 7 ? "week" : dte <= 14 ? "2wk" : "all";
// "2026-08-03" → {chip:"8/3 一", full:"8/3 周一"};dte==0 时加 0DTE 标
function expLabel(exp, dte) {
  if (!exp) return { chip: "≤30d", full: "≤30d 聚合" };
  const d = new Date(exp + "T00:00:00"), wd = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  const z = dte === 0 ? " 0DTE" : "";
  return { chip: `${md} ${wd}${z}`, full: `${md} 周${wd}${z}` };
}
let chart, candles, volume, ema9L, ema21L, vwapL, bbU, bbL, vsU, vsL, subChart, gexLine;
let indSub, atrL, pdiL, mdiL, adxL;  // 指标副图(ATR / DMI-ADX,与价格不同量纲,单独一栏)
let overlayOn = JSON.parse(localStorage.getItem("wbOverlays") || "null")
  || { ema9: true, ema21: true, vwap: true, bb: false, vsig: false, atr: false, adx: false };  // 默认只开 EMA/VWAP,其余按需勾
// AVWAP:手动多锚(点击图上任意 bar 从那时刻起算),按时间戳存、跨周期一致、可留多条确认点位
let avwapLines = [];   // 每锚一条线 [{series, ts, color}]
let avwapCtx = null;   // 当前 {bars, t},供点击锚定映射
let avwapAdd = localStorage.getItem("wbAvwapAdd") === "1";           // 点击锚定模式开关
let avwapAnchors = JSON.parse(localStorage.getItem("wbAvwap") || "{}");  // {sym:[epoch,...]} 按票持久
let showETH = localStorage.getItem("wbShowETH") === "1";  // 分时图默认只画 RTH;开则含盘前盘后
let hoverLevels = [];       // flip / MaxPain 横线的 {name,color,price},供 hover 识别
let hoverSeries = [];       // 叠加曲线的 {series,name,color},供 hover 识别
let priceLines = [];
let pollTimer = null;
let ladderRetry = 0;  // 首屏梯子重试计数(坐标系就绪前 priceToCoordinate 返回 null)
let ladderView = null;    // 梯的纵向视窗 {lo,hi};null=自动(贴合K线)。滚轮/拖动设置,双击复位
let ladderBounds = null;  // 当前梯行权价范围 {min,max},限制视窗滚动边界(=已计算 GEX 的范围)

/* lightweight-charts 按 UTC 显示,把时间戳平移成本地时间 */
// 某时刻 ET 相对 UTC 的偏移(分钟,正=落后 UTC:EDT=240/EST=300),含夏令时。
// 用它(而非浏览器 getTimezoneOffset)把 UTC 平移,使 K 线时间轴恒显示美东时间,不随访问者时区变。
const ET_OFF_FMT = new Intl.DateTimeFormat("en-US", { timeZone: ET, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const etOffsetMin = (ms) => {
  const p = Object.fromEntries(ET_OFF_FMT.formatToParts(ms).filter((x) => x.type !== "literal").map((x) => [x.type, +x.value]));
  return (ms - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)) / 60000;
};
const tconv = (ms) => Math.floor(ms / 1000) - etOffsetMin(ms) * 60;
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: ET });

/* ---------- 数据变换 ---------- */
function researchOf(sym) { return RESEARCH?.tickers?.[sym] || {}; }
function barsOf(sym) { return BARS?.tickers?.[sym] || {}; }  // 高频K线在独立文件

function aggregate(bars, n) {
  // 按 n 根合并,跨交易日断开
  const out = [];
  let buf = [];
  for (const b of bars) {
    if (buf.length && (etDay(buf[0][0]) !== etDay(b[0]) || buf.length >= n)) {
      out.push(merge(buf)); buf = [];
    }
    buf.push(b);
  }
  if (buf.length) out.push(merge(buf));
  return out;
  function merge(bs) {
    return [bs[0][0], bs[0][1], Math.max(...bs.map((x) => x[2])),
            Math.min(...bs.map((x) => x[3])), bs[bs.length - 1][4],
            bs.reduce((s, x) => s + x[5], 0), null];
  }
}

// 是否在美东常规交易时段(RTH)9:30–16:00 的工作日;用于过滤盘前盘后稀薄 bar
const RTH_FMT = new Intl.DateTimeFormat("en-US", { timeZone: ET, hourCycle: "h23", weekday: "short", hour: "numeric", minute: "numeric" });
function isRTH(ms) {
  const p = RTH_FMT.formatToParts(new Date(ms));
  const g = (t) => p.find((x) => x.type === t)?.value;
  if (g("weekday") === "Sat" || g("weekday") === "Sun") return false;
  const m = +g("hour") * 60 + +g("minute");
  return m >= 570 && m < 960;  // ET 9:30(570)~16:00(960)
}

function barsFor(sym, tf) {
  const b = barsOf(sym);
  if (tf === "1m") return b.bars_1m || [];
  if (tf === "5m") return b.bars_5m || [];
  if (tf === "15m") return b.bars_15m || aggregate(b.bars_5m || [], 3);  // 后端原生15m,缺失时回退5m聚合
  return researchOf(sym).bars_d || [];
}

function ema(closes, n) {
  const k = 2 / (n + 1);
  const out = [];
  let prev = null;
  closes.forEach((c, i) => {
    prev = prev == null ? c : c * k + prev * (1 - k);
    out.push(i < n - 1 ? null : prev);
  });
  return out;
}

function vwapPerDay(bars) {
  const out = [];
  let day = null, pv = 0, vol = 0;
  for (const b of bars) {
    const d = etDay(b[0]);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const price = b[6] || (b[2] + b[3] + b[4]) / 3;
    pv += price * b[5]; vol += b[5];
    out.push(vol ? pv / vol : null);
  }
  return out;
}

/* VWAP 统一走 1m 口径:无论显示周期是 1m/5m/15m,会话 VWAP 都从 1m 线算(每日重置、优先用 vw),
   保证准度不随周期变粗、且与 stat 数字同源。rth 决定是否只用 RTH 分钟(跟随图表 RTH/+ETH 模式)。 */
function vwap1mSeries(sym, rth) {
  const b1 = rth ? barsFor(sym, "1m").filter((b) => isRTH(b[0])) : barsFor(sym, "1m");
  return { bars: b1, vals: vwapPerDay(b1) };
}
/* 把 1m 累计 VWAP 采样到显示周期的每根 bar:取累计到该 bar 末的值(末根=最新 1m 值)。
   1m 比显示周期细,每根显示 bar 区间内必有 ≥1 根 1m,故不会串日;无 1m 覆盖的老 bar 留 null。 */
function vwapSampledTo(sym, rth, dbars) {
  const { bars: b1, vals } = vwap1mSeries(sym, rth);
  const out = new Array(dbars.length).fill(null);
  let j = 0;
  for (let i = 0; i < dbars.length; i++) {
    const nextOpen = i + 1 < dbars.length ? dbars[i + 1][0] : Infinity;
    let v = null;
    while (j < b1.length && b1[j][0] < nextOpen) { if (vals[j] != null) v = vals[j]; j++; }
    out[i] = v;
  }
  return out;
}
/* 当前会话 1m VWAP 的最新值,供 stat 与图表线保持一致。 */
function vwapLatest(sym, rth) {
  const { vals } = vwap1mSeries(sym, rth);
  for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return vals[i];
  return null;
}

/* 布林带:中轨 SMA(n),上下轨 ±k×标准差。返回 {up, lo} 与 closes 对齐(前 n-1 为 null) */
function bollinger(closes, n = 20, k = 2) {
  const up = [], lo = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < n - 1) { up.push(null); lo.push(null); continue; }
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += closes[j];
    const m = s / n;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (closes[j] - m) ** 2;
    const sd = Math.sqrt(v / n);
    up.push(m + k * sd); lo.push(m - k * sd);
  }
  return { up, lo };
}

/* Wilder 平滑(RMA):首个非空值起累积 n 个做 SMA 播种,之后 (prev*(n-1)+v)/n。保留前导 null */
function rma(vals, n) {
  const out = new Array(vals.length).fill(null);
  let prev = null, sum = 0, cnt = 0;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v == null) continue;
    if (prev == null) { sum += v; if (++cnt === n) { prev = sum / n; out[i] = prev; } }
    else { prev = (prev * (n - 1) + v) / n; out[i] = prev; }
  }
  return out;
}

/* True Range 序列(与 bars 对齐,首根为 null)。bars: [t,o,h,l,c,v] */
function trueRanges(bars) {
  const tr = [null];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i][2], l = bars[i][3], pc = bars[i - 1][4];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return tr;
}

/* ATR(n):真实波幅的 Wilder 平滑,价格单位、无方向。做止损距离/仓位/实现波动 */
function atr(bars, n = 14) { return rma(trueRanges(bars), n); }

/* DMI/ADX(n):+DI/−DI=方向动量,ADX=趋势强度(0–100,非方向)。ADX>25 趋势/<20 震荡 */
function dmiAdx(bars, n = 14) {
  const len = bars.length, pdm = [null], mdm = [null], tr = trueRanges(bars);
  for (let i = 1; i < len; i++) {
    const up = bars[i][2] - bars[i - 1][2];   // high − prevHigh
    const dn = bars[i - 1][3] - bars[i][3];   // prevLow − low
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  const sP = rma(pdm, n), sM = rma(mdm, n), sT = rma(tr, n);
  const pdi = [], mdi = [], dx = [];
  for (let i = 0; i < len; i++) {
    if (sT[i] == null || !sT[i]) { pdi.push(null); mdi.push(null); dx.push(null); continue; }
    const p = 100 * sP[i] / sT[i], m = 100 * sM[i] / sT[i], s = p + m;
    pdi.push(p); mdi.push(m); dx.push(s ? 100 * Math.abs(p - m) / s : 0);
  }
  return { pdi, mdi, adx: rma(dx, n) };
}

/* VWAP ±kσ 带:σ 为按会话累计的成交量加权标准差(每日重置),返回 {up, lo} */
function vwapBands(bars, k = 1) {
  const up = [], lo = [];
  let day = null, sv = 0, svp = 0, svp2 = 0;
  for (const b of bars) {
    const d = etDay(b[0]);
    if (d !== day) { day = d; sv = svp = svp2 = 0; }
    const p = b[6] || (b[2] + b[3] + b[4]) / 3, v = b[5];
    sv += v; svp += v * p; svp2 += v * p * p;
    if (sv > 0) {
      const vw = svp / sv, sd = Math.sqrt(Math.max(svp2 / sv - vw * vw, 0));
      up.push(vw + k * sd); lo.push(vw - k * sd);
    } else { up.push(null); lo.push(null); }
  }
  return { up, lo };
}

/* Anchored VWAP:从锚点(swing 低/高/区间起点)起的成交量加权均价 = 成本基代理 */
const AVWAP_COLORS = ["#fb923c", "#22d3ee", "#a3e635", "#f472b6", "#facc15", "#818cf8"];
const AV_FMT = new Intl.DateTimeFormat("en-US", { timeZone: ET, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function avwapAnchorLabel(ep) { return ep == null ? "" : AV_FMT.format(new Date(ep)); }

/* 从锚点 epoch 起的 AVWAP(成交量加权),按时间戳锚 → 跨周期一致。
   锚落在当前窗口之前(数据不全)或之后 → 返回 [](不画,避免误导)。 */
function computeAVWAP(bars, t, anchor) {
  if (!bars.length || anchor == null) return [];
  const start = bars.findIndex((b) => b[0] >= anchor);
  if (start < 0 || (start === 0 && anchor < bars[0][0])) return [];
  const out = [];
  let pv = 0, vol = 0;
  for (let i = start; i < bars.length; i++) {
    const b = bars[i];
    const p = b[6] || (b[2] + b[3] + b[4]) / 3;
    pv += p * b[5]; vol += b[5];
    out.push({ time: t(b), value: vol ? pv / vol : p });
  }
  return out;
}

/* 当前票的锚点集 → 一组 AVWAP 线(数量随锚点增删,颜色按序循环)*/
function renderAvwap(bars, t) {
  const anchors = (avwapAnchors[SYM] || []).slice().sort((a, b) => a - b);
  while (avwapLines.length < anchors.length) {
    avwapLines.push({ series: chart.addLineSeries({ lineWidth: 2, priceLineVisible: false, lastValueVisible: false }), ts: null, color: null });
  }
  while (avwapLines.length > anchors.length) chart.removeSeries(avwapLines.pop().series);
  anchors.forEach((a, i) => {
    const l = avwapLines[i], color = AVWAP_COLORS[i % AVWAP_COLORS.length];
    l.ts = a; l.color = color;
    l.series.applyOptions({ color });
    l.series.setData(computeAVWAP(bars, t, a));
  });
}

const lastClose = (sym) => {
  const b = barsOf(sym).bars_1m || barsOf(sym).bars_5m || [];
  return b.length ? b[b.length - 1][4] : null;
};
const spotOf = (sym) => (RESEARCH?.snapshots?.[sym]?.price) ?? lastClose(sym) ?? GEX?.tickers?.[sym]?.spot;

/* 选中到期桶的 GEX;为空(如当日无 0DTE 合约)则回退到最近的非空桶。
   口径=流量时读 .flow(无流量数据则自动退回名义并标注) */
function gexBucketData(sym) {
  const t0 = GEX?.tickers?.[sym];
  if (!t0) return null;
  const flowMiss = gexCaliber === "flow" && !t0.flow;
  const t = gexCaliber === "flow" && t0.flow ? t0.flow : t0;
  const cal = gexCaliber === "flow" && t0.flow ? "flow" : "nominal";
  const conf = { classified: t.classified, coverage: t.coverage, ambiguity: t.ambiguity };
  const base = { spot: t.spot, caliber: cal, flowMiss, ...conf };
  const agg = (t.buckets && t.buckets.all) || { net_gex: 0, flip: null, by_strike: [] };
  const asAgg = (fallback) => ({ ...base, ...agg, bucket: "all", dte: null, label: "≤30d", fallback });
  if (gexBucket === "all") return asAgg(false);
  const byExp = t.by_exp || [];
  let e = byExp.find((x) => x.exp === gexBucket);   // 选中的单到期
  const fallback = !e && gexBucket !== "near";       // 选中的到期已滚动/换票 → 回退最近,标 nearest
  if (!e) e = byExp[0];                              // "near" 或回退 → 最近一个到期
  if (!e) return asAgg(true);                        // 无 by_exp(旧数据)→ 聚合兜底
  return { ...base, net_gex: e.net_gex, flip: e.flip, by_strike: e.by_strike,
    bucket: e.exp, dte: e.dte, label: expLabel(e.exp, e.dte).full, fallback };
}

/* 到期选择器:动态列出当前票最近 N 个真实到期日 + ≤30d 聚合(单到期不被 M/W/F 稀释)*/
function renderExpChips() {
  const box = $("gex-exp");
  if (!box) return;
  const t0 = GEX?.tickers?.[SYM];
  const t = gexCaliber === "flow" && t0?.flow ? t0.flow : t0;
  const byExp = t?.by_exp || [];
  const cur = gexBucketData(SYM)?.bucket;   // 实际解析到的(near/回退后的真实值)
  const chip = (b, lbl, ttl, on) => `<button data-b="${b}" class="${on ? "active" : ""}" title="${ttl}">${lbl}</button>`;
  const parts = byExp.map((e) => { const L = expLabel(e.exp, e.dte); return chip(e.exp, L.chip, `${L.full}(单到期,不与其他到期混合)`, cur === e.exp); });
  parts.push(chip("all", "≤30d", "所有 ≤30 天到期之和(总对冲压力 / flip 口径)", cur === "all"));
  box.innerHTML = parts.join("");
}

/* ---------- 图表初始化 ---------- */
const chartTheme = {
  layout: { background: { color: "transparent" }, textColor: "#8b96ad", fontSize: 11, attributionLogo: false },
  grid: { vertLines: { color: "#1c2539" }, horzLines: { color: "#1c2539" } },
  crosshair: { mode: LWC.CrosshairMode.Normal },
  timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#2a3550" },
  rightPriceScale: { borderColor: "#2a3550" },
  autoSize: true,
};

function initCharts() {
  chart = LWC.createChart($("chart"), chartTheme);
  candles = chart.addCandlestickSeries({
    upColor: "#34d399", downColor: "#f87171", borderVisible: false,
    wickUpColor: "#34d399", wickDownColor: "#f87171",
    priceLineVisible: false,  // 关掉自带的当前价虚线(梯上已有 Spot;右轴仍显示末值)
    autoscaleInfoProvider: ladderAutoscale,  // ladderView 非空时强制价格轴=视窗,梯与K线共此范围
  });
  volume = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  // 标签默认隐藏(不占右轴),改为 hover 到线附近时浮出名称(见 initHoverLegend)
  ema9L = chart.addLineSeries({ color: "#60a5fa", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  ema21L = chart.addLineSeries({ color: "#c084fc", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  vwapL = chart.addLineSeries({ color: "#fbbf24", lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false });
  bbU = chart.addLineSeries({ color: "#2dd4bf", lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false });
  bbL = chart.addLineSeries({ color: "#2dd4bf", lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false });
  vsU = chart.addLineSeries({ color: "#fcd34d", lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false });
  vsL = chart.addLineSeries({ color: "#fcd34d", lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false });
  hoverSeries = [
    { series: ema9L, name: "EMA9", color: "#60a5fa" },
    { series: ema21L, name: "EMA21", color: "#c084fc" },
    { series: vwapL, name: "VWAP", color: "#fbbf24" },
    { series: bbU, name: "BB Upper (+2σ)", color: "#2dd4bf" },
    { series: bbL, name: "BB Lower (−2σ)", color: "#2dd4bf" },
    { series: vsU, name: "VWAP +σ", color: "#fcd34d" },
    { series: vsL, name: "VWAP −σ", color: "#fcd34d" },
  ];
  initHoverLegend();
  applyOverlayVis();  // 按 overlayOn 设置各叠加层可见性
  // 点击锚定 AVWAP:开启"点击锚定"后,点图上任一 bar 从那时刻加一条;点已有锚附近则删
  chart.subscribeClick((param) => {
    if (!avwapAdd || !avwapCtx || param.logical == null) return;
    const { bars } = avwapCtx;
    const i = Math.round(param.logical);
    if (i < 0 || i >= bars.length) return;
    const ep = bars[i][0], list = avwapAnchors[SYM] || (avwapAnchors[SYM] = []);
    const gap = bars.length > 1 ? Math.abs(bars[1][0] - bars[0][0]) : 6e4;   // 容差=一根 bar
    const at = list.findIndex((a) => Math.abs(a - ep) <= gap);
    if (at >= 0) list.splice(at, 1); else list.push(ep);
    if (!list.length) delete avwapAnchors[SYM];
    localStorage.setItem("wbAvwap", JSON.stringify(avwapAnchors));
    renderChart();
  });

  subChart = LWC.createChart($("gex-sub"), { ...chartTheme, timeScale: { ...chartTheme.timeScale, timeVisible: true } });
  gexLine = subChart.addLineSeries({ color: "#60a5fa", lineWidth: 2, priceFormat: { type: "custom", formatter: (v) => (v / 1e6).toFixed(0) + "M" } });

  // 指标副图(DMI/ADX + ATR)改为懒创建(见 ensureIndSub):必须在容器 display:"" 可见时创建,
  // autoSize 才能量到真实尺寸;若在此处(容器 display:none 0×0)创建,autoSize 之后不恢复、画布 0 宽画不出线。
  chart.timeScale().subscribeVisibleLogicalRangeChange(syncSubs);  // 主图平移/缩放 → 两副图按时间范围对齐

  // 直接调用(不裹 rAF):后台标签页 rAF 会被节流不触发。
  // subscribeVisibleLogicalRangeChange 在图表坐标就绪后才触发,是最可靠的重画时机。
  chart.timeScale().subscribeVisibleLogicalRangeChange(renderLadder);  // VP 已并入 renderLadder
  const ro = new ResizeObserver(renderLadder);  // 首屏 flex 宽度就绪后重画
  ro.observe($("chart"));
  ro.observe($("ladder-box"));
  initLadderZoom();  // 梯纵向缩放/平移(K线随之对齐)
}

/* 可勾选叠加层(K线/量常驻);AVWAP 由锚点选择器单独控制 */
const OVERLAYS = [
  { key: "ema9", label: "EMA9", get: () => [ema9L] },
  { key: "ema21", label: "EMA21", get: () => [ema21L] },
  { key: "vwap", label: "VWAP", get: () => [vwapL] },
  { key: "bb", label: "BB(20,2)", get: () => [bbU, bbL] },
  { key: "vsig", label: "VWAP±σ", get: () => [vsU, vsL] },
  { key: "adx", label: "ADX/DMI", ind: true, get: () => [pdiL, mdiL, adxL] },
  { key: "atr", label: "ATR", ind: true, get: () => [atrL] },
];

function applyOverlayVis() {
  for (const o of OVERLAYS) {
    const on = overlayOn[o.key] !== false;
    o.get().forEach((s) => s && s.applyOptions({ visible: on }));
  }
  renderIndSub();  // 指标副图:按开关显隐整栏 + 填数据
}

function renderOverlayChips() {
  $("overlay-chips").innerHTML = OVERLAYS.map((o) =>
    `<button data-ov="${o.key}" class="${overlayOn[o.key] !== false ? "active" : ""}">${o.label}</button>`).join("");
}

/* hover 到某条线附近(纵向 ≤7px)才浮出它的名称+数值;不占右轴、默认隐藏 */
function initHoverLegend() {
  const HIT = 7;  // 命中容差(像素)
  chart.subscribeCrosshairMove((param) => {
    const el = $("chart-legend");
    if (!el) return;
    if (!param.point || !param.time) { el.style.display = "none"; return; }
    const cy = param.point.y;
    const hits = [];
    for (const it of hoverSeries) {
      const d = param.seriesData.get(it.series);
      const v = d && (d.value ?? d.close);
      if (v == null) continue;
      const y = it.series.priceToCoordinate(v);
      if (y != null && Math.abs(y - cy) <= HIT) hits.push({ name: it.name, color: it.color, v });
    }
    for (const lv of hoverLevels) {
      const y = candles.priceToCoordinate(lv.price);
      if (y != null && Math.abs(y - cy) <= HIT) hits.push({ name: lv.name, color: lv.color, v: lv.price });
    }
    for (const l of avwapLines) {   // 动态锚定 AVWAP 线
      const d = param.seriesData.get(l.series);
      const v = d && d.value;
      if (v == null) continue;
      const y = l.series.priceToCoordinate(v);
      if (y != null && Math.abs(y - cy) <= HIT) hits.push({ name: `AVWAP ${avwapAnchorLabel(l.ts)}`, color: l.color, v });
    }
    if (!hits.length) { el.style.display = "none"; return; }
    el.innerHTML = hits.map((h) => `<span style="color:${h.color}">● ${esc(h.name)} ${h.v.toFixed(2)}</span>`).join("<br>");
    el.style.display = "block";
    const w = $("chart").clientWidth;
    el.style.left = Math.min(param.point.x + 14, w - 130) + "px";
    el.style.top = (cy + 12) + "px";
  });
}

/* ---------- 主图 ---------- */
function renderChart() {
  let bars = barsFor(SYM, TF);
  const daily = TF === "1d";
  if (!daily && !showETH) bars = bars.filter((b) => isRTH(b[0]));  // 默认只画 RTH(去盘前盘后);VWAP/带/AVWAP 随之基于 RTH
  const t = (b) => daily ? etDay(b[0]) : tconv(b[0]);
  candles.setData(bars.map((b) => ({ time: t(b), open: b[1], high: b[2], low: b[3], close: b[4] })));
  volume.setData(bars.map((b) => ({ time: t(b), value: b[5], color: b[4] >= b[1] ? "#34d39955" : "#f8717155" })));
  const closes = bars.map((b) => b[4]);
  const line = (vals) => vals.map((v, i) => v == null ? null : ({ time: t(bars[i]), value: v })).filter(Boolean);
  ema9L.setData(line(ema(closes, 9)));
  ema21L.setData(line(ema(closes, 21)));
  vwapL.setData(daily ? [] : line(vwapSampledTo(SYM, !showETH, bars)));  // VWAP 统一 1m 口径,采样到显示周期
  // 布林带 BB(20,2)
  const bb = bollinger(closes, 20, 2);
  bbU.setData(line(bb.up)); bbL.setData(line(bb.lo));
  // VWAP ±1σ 带(仅盘中)
  if (daily) { vsU.setData([]); vsL.setData([]); }
  else { const vb = vwapBands(bars, 1); vsU.setData(line(vb.up)); vsL.setData(line(vb.lo)); }
  // Anchored VWAP:每个手动锚点一条线(按时间戳锚,跨周期一致);供点击锚定映射
  avwapCtx = { bars, t };
  renderAvwap(bars, t);

  // 关键价位线: gamma flip / Max Pain(名称也走 hover,不常驻)
  priceLines.forEach((l) => candles.removePriceLine(l));
  priceLines = [];
  const flip = gexBucketData(SYM)?.flip;
  const mp = researchOf(SYM).options?.max_pain;
  if (flip != null) priceLines.push(candles.createPriceLine({ price: flip, color: "#fbbf24", lineStyle: LWC.LineStyle.Dashed, lineWidth: 1 }));
  if (mp != null) priceLines.push(candles.createPriceLine({ price: mp, color: "#c084fc", lineStyle: LWC.LineStyle.Dashed, lineWidth: 1 }));
  hoverLevels = [];
  if (flip != null) hoverLevels.push({ name: "flip", color: "#fbbf24", price: flip });
  if (mp != null) hoverLevels.push({ name: "MaxPain", color: "#c084fc", price: mp });

  const visible = TF === "1d" ? 130 : TF === "1m" ? 200 : 160;
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - visible), to: bars.length + 3 });
  renderLadder();  // 内含 VP 叠加;setVisibleLogicalRange 也会触发 subscribe 兜底
  renderIndSub();  // ATR / ADX 指标副图(与主图同源 bars)
}

/* ---------- 指标副图(ATR / DMI-ADX;与价格不同量纲,单独一栏)---------- */
// 懒创建 ind-sub 图表:第一次要显示时才建。此刻容器已 display:"" 可见,autoSize 能量到真实尺寸。
function ensureIndSub() {
  if (indSub) return;
  indSub = LWC.createChart($("ind-sub"), { ...chartTheme, timeScale: { ...chartTheme.timeScale, timeVisible: true } });
  pdiL = indSub.addLineSeries({ color: "#34d399", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });          // +DI
  mdiL = indSub.addLineSeries({ color: "#f87171", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });          // −DI
  adxL = indSub.addLineSeries({ color: "#fbbf24", lineWidth: 2, priceLineVisible: false, lastValueVisible: false });          // ADX
  atrL = indSub.addLineSeries({ color: "#a78bfa", lineWidth: 1, priceScaleId: "atr", priceLineVisible: false, lastValueVisible: false });
  indSub.priceScale("atr").applyOptions({ scaleMargins: { top: 0.55, bottom: 0 } });  // ATR 压在下半,和 DMI 少重叠
  const r = chart.timeScale().getVisibleLogicalRange();
  if (r) indSub.timeScale().setVisibleLogicalRange(r);  // 立刻对齐主图 x 轴
}

function renderIndSub() {
  const el = $("ind-sub"), tt = $("ind-sub-title");
  if (!el) return;
  const paneOn = overlayOn.atr || overlayOn.adx;
  el.style.display = paneOn ? "" : "none";
  if (tt) tt.parentElement && (tt.style.display = paneOn ? "" : "none");
  if (!paneOn) { if (indSub) { pdiL.setData([]); mdiL.setData([]); adxL.setData([]); atrL.setData([]); } return; }
  ensureIndSub();  // 首次显示时懒创建(容器已可见 → autoSize 量到真实尺寸)
  let bars = barsFor(SYM, TF);
  const daily = TF === "1d";
  if (!daily && !showETH) bars = bars.filter((b) => isRTH(b[0]));
  const t = (b) => daily ? etDay(b[0]) : tconv(b[0]);
  const line = (vals) => vals.map((v, i) => v == null ? null : ({ time: t(bars[i]), value: v })).filter(Boolean);
  if (overlayOn.adx) { const { pdi, mdi, adx } = dmiAdx(bars, 14); pdiL.setData(line(pdi)); mdiL.setData(line(mdi)); adxL.setData(line(adx)); }
  else { pdiL.setData([]); mdiL.setData([]); adxL.setData([]); }
  atrL.setData(overlayOn.atr ? line(atr(bars, 14)) : []);
  if (tt) tt.textContent = `${overlayOn.adx ? "ADX(14) 趋势强度 · +DI/−DI 方向" : ""}${overlayOn.adx && overlayOn.atr ? "   ·   " : ""}${overlayOn.atr ? "ATR(14) 波幅(右轴)" : ""}`;
  requestAnimationFrame(syncSubs);  // 显示/换数据后按主图时间范围对齐
}

// 两个副图(ADX/DMI、净GEX)按主图"可见时间范围"对齐。副图数据网格与主图不同(GEX 稀疏、
// 指标有 warmup 偏移),故用时间范围而非逻辑索引,平移/缩放主图时都能对齐。
function syncSubs() {
  const tr = chart && chart.timeScale().getVisibleRange();
  if (!tr) return;
  try { if (subChart) subChart.timeScale().setVisibleRange(tr); } catch { /* 数据未就绪 */ }
  try { if (indSub && $("ind-sub").style.display !== "none") indSub.timeScale().setVisibleRange(tr); } catch { /* 容器刚显示 */ }
}

/* ---------- 盘中净 GEX 副图(按所选到期桶) ---------- */
function renderGexSub() {
  // 与上方 stat tile 对齐:同一个已回退的桶(eff.bucket)+ 同一个口径(Real 缺失时退 Raw)
  const eff = gexBucketData(SYM);
  const bkey = expToHistBucket(eff?.dte);   // 单到期 → 其所属累计桶(历史序列只有累计桶)
  const useFlow = gexCaliber === "flow" && !eff?.flowMiss;
  const pts = (GEXH?.points || []).filter((p) => p.sym === SYM);
  gexLine.setData(pts.map((p) => {
    const nets = (useFlow && p.fnets) ? p.fnets : p.nets;  // 逐点:该口径无数据(旧点)则退 Raw
    const top = (useFlow && p.fnet != null) ? p.fnet : p.net;
    return { time: tconv(Date.parse(p.t)), value: (nets && nets[bkey] != null) ? nets[bkey] : top };
  }));
  const gt = $("gex-sub-title");
  if (gt) {
    const upd = GEX?.updated_at ? ` · updated ${fmtDT(GEX.updated_at)}` : "";
    const scope = eff?.bucket === "all" ? "≤30d 聚合" : `${eff?.label || ""}(所在 ${GEX_BUCKET_LABEL[bkey]} 序列)`;
    gt.textContent = `Intraday net GEX trend · ${scope} · ${useFlow ? "Real" : "Raw"}${upd}`;
  }
  requestAnimationFrame(syncSubs);  // 对齐主图时间范围(替代 fitContent 自适应,否则会覆盖 x 轴对齐)
}

/* ---------- 行权价梯(与主图共享价格轴) ---------- */
function histDay() { return ladderDay ? WEEK?.days?.[ladderDay]?.[SYM] : null; }  // 选中的本周历史某日快照

function ladderRows() {
  if (ladderMode === "gex") {
    const h = histDay();  // 本周历史某日:用当周到期(week 桶)的 by_strike,按口径取 nominal/real
    if (h) {
      const useReal = gexCaliber === "flow";
      return h.rows.map(([k, nom, real]) => ({ strike: k, a: (useReal && real != null) ? real : nom, b: 0, net: true }))
        .filter((r) => r.a != null);
    }
    return (gexBucketData(SYM)?.by_strike || []).map((r) => ({ strike: r.strike, a: r.net, b: 0, net: true }));
  }
  if (ladderMode === "netflow") {  // 每档净主动买卖(buy−sell),单条净值:绿=净买/红=净卖
    return (researchOf(SYM).options?.by_strike || [])
      .filter((r) => r.netflow != null)
      .map((r) => ({ strike: r.strike, a: r.netflow, b: 0, net: true }));
  }
  const key = ladderMode === "oi" ? "oi" : "vol";
  return (researchOf(SYM).options?.by_strike || []).map((r) => ({
    strike: r.strike, a: r[`call_${key}`] || 0, b: r[`put_${key}`] || 0, net: false,
  }));
}

function updateLadderTitle() {
  const m = { gex: "GEX", oi: "OI", vol: "Volume", netflow: "Net Flow" }[ladderMode];
  let suffix;
  if (ladderMode === "netflow") {
    suffix = " · 主动买卖(当日,calls+puts)";
  } else if (ladderMode === "gex" && ladderDay) {   // 本周历史某日:固定当周到期(week 桶)
    const cal = gexCaliber === "flow" ? "·Real" : "";
    suffix = ` (${ladderDay} 快照·当周到期${cal})`;
  } else if (ladderMode === "gex") {
    const b = gexBucketData(SYM);
    const cal = b?.caliber === "flow" ? "·Real" : gexCaliber === "flow" ? "·Real N/A→Raw" : "";
    suffix = ` (${b?.label || "≤30d"}${b?.fallback ? "·nearest" : ""}${cal})`;
  } else {
    suffix = " · all expiries";
  }
  const merged = ladderMode === "gex" ? (histDay()?.merged_index ?? GEX?.tickers?.[SYM]?.merged_index) : null;  // SPY = SPX主池+SPY(历史日用当日)
  $("ladder-title").textContent = `Strike Ladder · ${m}${suffix}${merged ? ` · +${merged}主池` : ""}`;
  const gexOnlyOpacity = ladderMode === "gex" ? "1" : "0.4";
  ($("gex-exp").closest(".tb-group") || $("gex-exp")).style.opacity = gexOnlyOpacity;
  ($("gex-caliber").closest(".tb-group") || $("gex-caliber")).style.opacity = gexOnlyOpacity;
  // 到期选择器由 renderExpChips 动态渲染(只列该票真实存在的到期),不再需要空桶置灰
}

// 价格轴范围提供者:ladderView 非空 → 强制轴=[lo,hi](K线与梯共此范围);null → 用默认自动缩放
function ladderAutoscale(orig) {
  return ladderView ? { priceRange: { minValue: ladderView.lo, maxValue: ladderView.hi } } : orig();
}
// 应用当前 ladderView:重触发价格轴缩放(重设 provider 使其重算),下一帧对齐重画梯
function applyLadderView() {
  if (!candles) return;
  candles.applyOptions({ autoscaleInfoProvider: (o) => ladderAutoscale(o) });  // 新引用→强制重算价格轴
  requestAnimationFrame(renderLadder);
}
// 把 ladderView 夹在 ladderBounds 内(保持跨度整体平移),跨度不小于总范围 2%
function clampLadderView() {
  if (!ladderView || !ladderBounds) return;
  let { lo, hi } = ladderView;
  const full = ladderBounds.max - ladderBounds.min;
  if (hi - lo < full * 0.02) { const c = (lo + hi) / 2, h = full * 0.01; lo = c - h; hi = c + h; }
  if (lo < ladderBounds.min) { hi += ladderBounds.min - lo; lo = ladderBounds.min; }
  if (hi > ladderBounds.max) { lo -= hi - ladderBounds.max; hi = ladderBounds.max; }
  ladderView = { lo: Math.max(lo, ladderBounds.min), hi: Math.min(hi, ladderBounds.max) };
}
// 梯的滚轮缩放 / 拖动平移 / 双击复位(纵向聚焦局部 GEX;K线随之对齐)
function initLadderZoom() {
  const box = $("ladder-box");
  if (!box) return;
  box.title = "滚轮缩放 · 拖动平移 · 双击复位(范围限于已计算的 GEX 行权价)";
  const chartH = () => $("chart").getBoundingClientRect().height;
  const seed = () => {  // 首次交互:从当前可视价格区间起步
    if (ladderView || !candles) return;
    const hi = candles.coordinateToPrice(0), lo = candles.coordinateToPrice(chartH());
    if (lo != null && hi != null) ladderView = { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
  };
  box.addEventListener("wheel", (e) => {
    e.preventDefault(); seed();
    if (!ladderView) return;
    const pc = candles.coordinateToPrice(e.clientY - $("chart").getBoundingClientRect().top);  // 光标价:用图表顶部为基,非 ladder-box(差 dy)
    const c = pc != null ? pc : (ladderView.lo + ladderView.hi) / 2;
    const f = e.deltaY > 0 ? 1.15 : 0.87;  // 下滚=范围放大(看更宽);上滚=范围缩小(放大局部)
    ladderView = { lo: c - (c - ladderView.lo) * f, hi: c + (ladderView.hi - c) * f };
    clampLadderView(); applyLadderView();
  }, { passive: false });
  let drag = null;
  box.addEventListener("mousedown", (e) => { seed(); if (ladderView) drag = { y: e.clientY, v: { ...ladderView } }; });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const dP = (e.clientY - drag.y) / chartH() * (drag.v.hi - drag.v.lo);  // 拖动:抓着内容走
    ladderView = { lo: drag.v.lo + dP, hi: drag.v.hi + dP };
    clampLadderView(); applyLadderView();
  });
  window.addEventListener("mouseup", () => { drag = null; });
  box.addEventListener("dblclick", () => { ladderView = null; applyLadderView(); });  // 复位=自动贴合K线
}

function renderWeekChips() {  // 本周每日 GEX 快照日期选择(仅当前票有的日子);Live=最新
  const box = $("gex-week-chips");
  if (!box) return;
  const days = WEEK?.days ? Object.keys(WEEK.days).filter((d) => WEEK.days[d][SYM]).sort() : [];
  if (ladderDay && !days.includes(ladderDay)) ladderDay = null;   // 当前票无此日 → 回 Live
  if (!days.length) { box.innerHTML = ""; return; }
  const wd = ["日", "一", "二", "三", "四", "五", "六"];
  const fmt = (d) => "周" + wd[new Date(d + "T00:00:00").getDay()] + " " + d.slice(5);
  const chip = (d, lbl, on) => `<button data-day="${d}" class="${on ? "active" : ""}" style="padding:2px 8px;font-size:11px">${lbl}</button>`;
  box.innerHTML = chip("", "Live", !ladderDay) + days.map((d) => chip(d, fmt(d), ladderDay === d)).join("");
}

function renderLadder() {
  renderWeekChips();   // 先校准 ladderDay(可能因换票被重置)再画
  const svg = $("ladder");
  if (!svg || !candles) return;
  updateLadderTitle();
  const rows = ladderRows();
  const box = $("ladder-box").getBoundingClientRect();
  const chartRect = $("chart").getBoundingClientRect();
  const H = chartRect.height;
  // 梯 SVG 在 ladder-box(标题+chips 下方),价格坐标却来自 #chart 顶部;两者相差 dy → 逐点补偿才对齐。
  // 堆叠(移动端)布局梯在图表下方、偏移过大 → 不补偿(无法也无需对齐)。yc(): 价格→梯 SVG 的 y。
  const dy0 = box.top - chartRect.top;
  const dy = (dy0 > 0 && dy0 < H * 0.5) ? dy0 : 0;
  const yc = (p) => { const y = candles.priceToCoordinate(p); return y == null ? null : y - dy; };
  const Hs = H - dy;  // 梯 SVG 显示高度:补偿 dy 后,把下沿截到与 K 线底沿齐平(顶已对齐 → 底也对齐)
  // 容器或图表尚未完成布局(宽/高≈0)→ 稍后重试,别画进塌陷的画布
  if ((box.width < 40 || H < 40) && ladderRetry < 40) { ladderRetry++; setTimeout(renderLadder, 80); return; }
  const W = Math.max(box.width, 60);
  svg.setAttribute("viewBox", `0 0 ${W} ${Hs}`);
  svg.setAttribute("width", W); svg.setAttribute("height", Hs);
  if (!rows.length) { svg.innerHTML = `<text x="8" y="20" fill="#8b96ad" font-size="11">No data (collect once)</text>`; return; }
  const ss = rows.map((r) => r.strike);  // 滚动边界 = 已计算 GEX 的行权价范围
  ladderBounds = { min: Math.min(...ss), max: Math.max(...ss) };
  // 中间零轴发散:正(绿)向右、负(红)向左;OI/量 模式 call 向右、put 向左
  const cx = W / 2, half = cx - 3;
  const magOf = (r) => r.net ? Math.abs(r.a) : Math.max(r.a, r.b);
  const maxV = Math.max(...rows.map(magOf), 1);
  const parts = [`<line x1="${cx}" y1="0" x2="${cx}" y2="${Hs}" stroke="#2a3550" stroke-width="1"/>`];
  const rowH = Math.max(Math.min(Hs / rows.length * 0.7, 9), 2);
  let placed = 0;
  for (const r of rows) {
    const y = yc(r.strike);
    if (y == null || y < 0 || y > Hs) continue;
    placed++;
    const yr = (y - rowH / 2).toFixed(1);
    if (r.net) {
      const w = Math.abs(r.a) / maxV * half, pos = r.a >= 0;
      parts.push(`<rect x="${(pos ? cx : cx - w).toFixed(1)}" y="${yr}" width="${w.toFixed(1)}" height="${rowH}" fill="${pos ? "#34d399" : "#f87171"}" opacity="0.85"><title>${r.strike}: ${fmtMoney(r.a)}</title></rect>`);
    } else {
      const wc = r.a / maxV * half, wp = r.b / maxV * half;
      parts.push(`<rect x="${cx.toFixed(1)}" y="${yr}" width="${wc.toFixed(1)}" height="${rowH}" fill="#34d399" opacity="0.85"><title>${r.strike} Call: ${fmtNum(r.a)}</title></rect>`);
      parts.push(`<rect x="${(cx - wp).toFixed(1)}" y="${yr}" width="${wp.toFixed(1)}" height="${rowH}" fill="#f87171" opacity="0.85"><title>${r.strike} Put: ${fmtNum(r.b)}</title></rect>`);
    }
  }
  // 量级最大的 4 行标注行权价(放在柱末端外侧,越界则贴边)
  [...rows].sort((a, b) => magOf(b) - magOf(a)).slice(0, 4).forEach((r) => {
    const y = yc(r.strike);
    if (y == null || y < 8 || y > Hs - 4) return;
    const toRight = r.net ? r.a >= 0 : true;  // net 按方向;OI/量 标在右侧
    const w = (r.net ? Math.abs(r.a) : Math.max(r.a, r.b)) / maxV * half;
    let lx = toRight ? cx + w + 2 : cx - w - 2, anchor = toRight ? "start" : "end";
    if (lx > W - 2) { lx = W - 2; anchor = "end"; } else if (lx < 2) { lx = 2; anchor = "start"; }
    parts.push(`<text x="${lx.toFixed(1)}" y="${(y + 3).toFixed(1)}" fill="#8b96ad" font-size="10" text-anchor="${anchor}">${r.strike}</text>`);
  });
  // 现价与 flip 横线
  const mark = (price, color, label) => {
    if (price == null) return;
    const y = yc(price);
    if (y == null || y < 0 || y > Hs) return;
    parts.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" stroke="${color}" stroke-dasharray="4 3" stroke-width="1"/>`);
    parts.push(`<text x="2" y="${(y - 3).toFixed(1)}" fill="${color}" font-size="10">${label}</text>`);
  };
  const hd = histDay();
  mark(hd ? hd.spot : spotOf(SYM), "#60a5fa", hd ? "Spot(当日)" : "Spot");  // 历史模式标当日 spot
  if (ladderMode === "gex" && !hd) mark(gexBucketData(SYM)?.flip, "#fbbf24", "flip");
  if (placed > 0) parts.push(volProfileFragment(W, H, dy));  // VP 轮廓线叠加(坐标就绪后,同 dy 补偿)
  svg.innerHTML = parts.join("");
  // 首屏图表坐标系未就绪时 priceToCoordinate 全返回 null → 稍后重试(用 setTimeout,后台标签页 rAF 会被节流)
  if (placed === 0 && rows.length && ladderRetry < 40) { ladderRetry++; setTimeout(renderLadder, 80); }
  else if (placed > 0) ladderRetry = 0;
}

/* Volume Profile 叠加片段:成交量按可见价格区间分箱,画成靠右轴锚定的轮廓线(+POC),
   叠在 GEX 梯同一 SVG、共享价格轴。返回 SVG 片段字符串,供 renderLadder 拼入。 */
function volProfileFragment(W, H, dy = 0) {
  const d = researchOf(SYM);
  const bars = (d.bars_d && d.bars_d.length >= 20) ? d.bars_d : barsFor(SYM, TF);
  if (!bars.length) return "";
  const NB = 60;
  const Hs = H - dy;  // 显示高度=下沿截到 K 线底(价格窗口仍用 chart 全高 H 查)
  const pTop = candles.coordinateToPrice(0), pBot = candles.coordinateToPrice(H);
  if (pTop == null || pBot == null) return "";
  const hi = Math.max(pTop, pBot), lo = Math.min(pTop, pBot);
  const binH = (hi - lo) / NB || 1;
  const bins = new Array(NB).fill(0);
  for (const b of bars) {  // 成交量在其 [low,high] 与可见区间的重叠部分内均摊
    const bl = Math.max(b[3], lo), bh = Math.min(b[2], hi);
    if (bh < bl) continue;
    const span = Math.max(b[2] - b[3], binH);
    const i0 = Math.max(Math.floor((bl - lo) / binH), 0);
    const i1 = Math.min(Math.floor((bh - lo) / binH), NB - 1);
    const per = b[5] * ((bh - bl) / span) / Math.max(i1 - i0 + 1, 1);
    for (let i = i0; i <= i1; i++) bins[i] += per;
  }
  const maxV = Math.max(...bins, 1);
  const poc = bins.indexOf(maxV);
  const VPW = Math.min(W * 0.55, 120);
  const x0 = W - VPW;  // 0 轴(底边)在左,成交量向右生长
  const price = (i) => lo + (i + 0.5) * binH;
  const pts = [];
  for (let i = 0; i < NB; i++) {
    const yv = candles.priceToCoordinate(price(i));
    const y = yv == null ? null : yv - dy;
    if (y == null || y < 0 || y > Hs) continue;
    pts.push([+(x0 + bins[i] / maxV * VPW).toFixed(1), +y.toFixed(1)]);
  }
  if (pts.length < 2) return "";
  const poly = pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join("");
  const area = `M${x0},${pts[0][1]} ` + pts.map((p) => `L${p[0]},${p[1]}`).join("") + ` L${x0},${pts[pts.length - 1][1]} Z`;
  let out = `<line x1="${x0}" y1="0" x2="${x0}" y2="${Hs}" stroke="#a78bfa55" stroke-width="1"/>`  // VP 0 轴
    + `<path d="${area}" fill="#a78bfa22"/><path d="${poly}" fill="none" stroke="#a78bfa" stroke-width="1.2"/>`;
  const ypv = candles.priceToCoordinate(price(poc));
  const yp = ypv == null ? null : ypv - dy;
  if (yp != null && yp >= 0 && yp <= Hs) {
    out += `<line x1="${x0.toFixed(1)}" y1="${yp.toFixed(1)}" x2="${W}" y2="${yp.toFixed(1)}" stroke="#f59e0b" stroke-dasharray="3 3" stroke-width="1"/><text x="${W}" y="${(yp - 2).toFixed(1)}" fill="#f59e0b" font-size="9" text-anchor="end">POC ${price(poc).toFixed(1)}</text>`;
  }
  return out;
}

/* ---------- 迷你行情卡(切票器 + 分组开关 + 增删) ---------- */
const isDeep = (s) => CFG.deep.includes(s);

function renderMiniCards() {
  const syms = CFG.watchlist.length ? CFG.watchlist : Object.keys(RESEARCH?.tickers || {});
  const deepSyms = syms.filter(isDeep);
  if (!SYM || !syms.includes(SYM)) SYM = deepSyms[0] || syms[0] || null;
  // 日均成交额水位:20日均量(EWMA,股)× 现价 ≈ 日均 $ 成交额,√相对当前列表最大值缩放(小票也可辨)
  const advOf = (s) => { const t = researchOf(s); return t.adv20 ?? t.short?.avg_daily_volume ?? null; };
  const dvOf = (s) => { const a = advOf(s); const sp = (RESEARCH?.snapshots?.[s] || {}).price ?? lastClose(s); return (a && sp) ? a * sp : null; };
  const fmtDV = (dv) => dv >= 1e9 ? `$${(dv / 1e9).toFixed(1)}B` : `$${Math.round(dv / 1e6)}M`;
  const maxDV = Math.max(1, ...syms.map((s) => dvOf(s) || 0));
  const cards = syms.map((s) => {
    const snap = RESEARCH?.snapshots?.[s] || {};
    const price = snap.price ?? lastClose(s);
    const pct = snap.chg_pct;
    const deep = isDeep(s);
    const dv = dvOf(s);
    const fill = dv ? Math.round(Math.sqrt(dv / maxDV) * 100) : 0;
    const volLbl = dv ? fmtDV(dv) : "—";
    return `<div class="mini-card ${s === SYM ? "active" : ""} ${deep ? "" : "wl-only"}" data-act="pick" data-sym="${esc(s)}">
      ${dv ? `<div class="mc-water" style="height:${fill}%"></div>` : ""}
      <div class="mc-main">
        <div class="sym">${esc(s)}</div>
        <div class="price">${price != null ? Number(price).toFixed(2) : "—"}</div>
        <div class="chg ${(pct ?? 0) >= 0 ? "up" : "down"}">${pct != null ? ((pct >= 0 ? "+" : "") + pct.toFixed(2) + "%") : ""}</div>
        <div class="mc-vol" title="日均成交额 ≈ 20日均量(EWMA)× 现价;水位=√相对列表最大值">${volLbl}</div>
      </div>
      <div class="mc-side">
        <div class="mc-grp">
          <button class="${deep ? "on" : ""}" data-act="deep" data-sym="${esc(s)}" title="Deep: candles/options/GEX/indicators">D</button>
          <button class="${deep ? "" : "on"}" data-act="wl" data-sym="${esc(s)}" title="Quotes/news only">Q</button>
        </div>
        <button class="mc-del" data-act="del" data-sym="${esc(s)}" title="Remove from list">✕</button>
      </div>
    </div>`;
  }).join("");
  const adder = `<div class="mini-card mc-add">
    <input id="mc-add-input" placeholder="+ ticker" maxlength="6" autocomplete="off">
  </div>`;
  $("mini-cards").innerHTML = syms.length ? cards + adder : adder;
  updateCfgStatus();
}

/* 共享 grid 磁贴(Price & GEX 指标行与 Options Panel 同款布局);v/sub 为空则不渲染 */
function tile(k, v, sub = "", cls = "", title = "") {
  return (v == null || v === "") ? "" :
    `<div class="opt-tile"${title ? ` title="${esc(title)}"` : ""}><div class="opt-k">${k}</div><div class="opt-v ${cls}">${v}${sub ? ` <span class="opt-sub">${sub}</span>` : ""}</div></div>`;
}

/* ---------- 指标栏(与 Options Panel 同款 grid 磁贴) ---------- */
function renderStats() {
  renderExpChips();  // 到期选择器随票/口径/数据动态刷新
  if (SYM && CFG.watchlist.length && !isDeep(SYM)) {
    $("wb-stats").innerHTML = `<span class="muted">${esc(SYM)} is in the "Quotes only" group — no deep data. Click "D" on its card to add to Deep.</span>`;
    return;
  }
  const d = researchOf(SYM);
  const g = gexBucketData(SYM) || {};
  const sv = (d.short_vol || [])[0];
  const time = d.asof ? new Date(d.asof).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: ET }) : null;
  // GEX 相对日均成交额:1% 变动的对冲量 ≈ 一天成交量的百分之几(跨标的可比的强度)
  // ADV 用 EWMA(span=20,新鲜)优先,回退旧的 short.avg_daily_volume
  const adv = d.adv20 ?? d.short?.avg_daily_volume;
  const gexPct = (g.net_gex != null && adv && g.spot) ? g.net_gex / (adv * g.spot) * 100 : null;
  // %float:同一 GEX 对冲量相对该票总流通市值(shares_out × spot),跨标的规模可比,不受当日量能波动影响
  const shares = d.ref?.shares_out;
  const floatPct = (g.net_gex != null && shares && g.spot) ? g.net_gex / (shares * g.spot) * 100 : null;
  const gexSub = [
    gexPct != null ? `${gexPct >= 0 ? "+" : ""}${gexPct.toFixed(1)}% ADV` : "",
    floatPct != null ? `${floatPct >= 0 ? "+" : ""}${floatPct.toFixed(2)}% flt` : "",
  ].filter(Boolean).join(" · ");
  // 桶/口径由上方按钮显示,标签不再重复;/1% 为默认口径,省略。仅回退时提示 nearest。
  const tiles = [
    tile("Data", time),
    tile("RSI 1m", d.ind?.rsi_m != null ? d.ind.rsi_m : null),
    tile("RSI D", d.ind?.rsi_d != null ? d.ind.rsi_d : null),
    tile("VWAP", (() => { const v = vwapLatest(SYM, !showETH); return v != null ? +v.toFixed(2) : (d.vwap != null ? d.vwap : null); })()),  // 与图表 VWAP 线同源(1m 口径,跟随 RTH/+ETH)
    tile(`Net GEX${g.fallback ? " (nearest)" : ""}`,
      g.net_gex != null ? fmtMoney(g.net_gex) : null,
      gexSub,
      (g.net_gex ?? 0) >= 0 ? "up" : "down", "1% underlying move → dealer hedge · % of ADV(当日量能)· % of float(总流通市值)"),
    tile("Flip", g.flip != null ? g.flip : null, "", "", "Gamma flip strike"),
    tile("Short%", sv?.ratio != null ? (sv.ratio * 100).toFixed(1) + "%" : null),
  ].join("");
  // 顶栏只留正股路径/风险类;IV/PCR/MaxPain/Premium 等期权交易指标已移到下方 Options Panel
  const note = g.flowMiss ? `<div class="muted small">Real (sampled) N/A(仅单名股;ETF 无实测符号,已退回 Raw)</div>` : "";
  $("wb-stats").innerHTML = `<div class="opt-grid">${tiles}</div>${note}`;
}

/* 已实现波动率(20 日收盘对数收益年化),用于 VRP */
function realizedVol(bars, n = 20) {
  if (!bars || bars.length < n + 1) return null;
  const cl = bars.slice(-(n + 1)).map((b) => b[4]);
  const r = [];
  for (let i = 1; i < cl.length; i++) if (cl[i - 1] > 0) r.push(Math.log(cl[i] / cl[i - 1]));
  if (r.length < 2) return null;
  const m = r.reduce((a, x) => a + x, 0) / r.length;
  const v = r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}

/* ---------- 期权面板:单一视图(grid 磁贴,同类指标合并到一行) ---------- */
function renderOptPanel() {
  const d = researchOf(SYM);
  const o = d.options;
  $("opt-src").textContent = RESEARCH?.options_source ? `(${RESEARCH.options_source === "massive" ? "Massive" : "Yahoo"} · ${o?.contracts ?? 0} ctr)` : "";
  if (!o) { $("opt-panel").innerHTML = `<div class="card empty">No options data — start a collection</div>`; return; }

  const spot = spotOf(SYM);
  const be = o.by_expiry || [];
  const ne = be[0]?.exp;
  const mmdd = (iso) => iso ? iso.slice(5).replace("-", "/") : "";

  // 预期波动(近月 + 1 日合并到一格)
  let emTile = "";
  if (o.atm_iv && ne && spot) {
    const days = Math.max((Date.parse(ne) - Date.now()) / 86400000 + 1, 0.5);
    const sig = o.atm_iv * Math.sqrt(days / 365), sig1 = o.atm_iv * Math.sqrt(1 / 365);
    emTile = tile(`Exp move (${mmdd(ne)})`, `&plusmn;${(sig * 100).toFixed(1)}%`,
      `$${(spot * (1 - sig)).toFixed(0)}–${(spot * (1 + sig)).toFixed(0)} · 1d &plusmn;${(sig1 * 100).toFixed(1)}%`,
      "", "Implied move to nearest expiry (and 1-day), from ATM IV");
  }

  const pv = (p) => (p != null ? `P${p}` : "");  // 自身历史分位标签

  // ATM IV(自身分位 + 相对 QQQ 倍数及其分位)
  const ivPct = o.atm_iv_pct;
  // front=最近到期原值;与常数期限口径明显背离时提示(近月 vega 塌缩/薄合约失真)
  const frontDiverge = o.atm_iv_front != null && o.atm_iv != null && Math.abs(o.atm_iv_front - o.atm_iv) >= 0.03;
  const ivSub = [
    ivPct != null ? `P${ivPct}` : "hist n/a",
    o.iv_vs_qqq != null ? `vs QQQ ${o.iv_vs_qqq}×${o.iv_vs_qqq_pct != null ? " " + pv(o.iv_vs_qqq_pct) : ""}` : "",
    frontDiverge ? `front ${(o.atm_iv_front * 100).toFixed(0)}%` : "",
  ].filter(Boolean).join(" · ");
  const ivTile = tile(`ATM IV${o.atm_iv_dte ? ` ${o.atm_iv_dte}d` : ""}`, o.atm_iv != null ? (o.atm_iv * 100).toFixed(0) + "%" : "&mdash;",
    ivSub,
    ivPct != null && ivPct >= 70 ? "down" : ivPct != null && ivPct <= 30 ? "up" : "",
    "ATM IV(常数期限≥20d · OI 加权 · 脏报价过滤)· 自身分位(P≥70 贵/≤30 便宜)· 相对 QQQ · front=最近到期原值(近月失真参考)");

  // IV skew(自身分位 + 相对 QQQ 的 skew 价差)
  const sk = o.iv_skew;
  const skewSub = sk ? [
    sk.rr > 0.01 ? "put skew" : sk.rr < -0.01 ? "call skew" : "flat",
    pv(o.skew_rr_pct),
    o.skew_vs_qqq != null ? `${o.skew_vs_qqq >= 0 ? "+" : ""}${(o.skew_vs_qqq * 100).toFixed(0)}pt vs QQQ` : "",
  ].filter(Boolean).join(" · ") : "";
  const skewTile = sk ? tile("IV skew", `${sk.rr >= 0 ? "+" : ""}${(sk.rr * 100).toFixed(1)}%`, skewSub, sk.rr >= 0 ? "down" : "up", `RR = ~7% OTM put IV − call IV (P${(sk.put_iv * 100).toFixed(0)}/C${(sk.call_iv * 100).toFixed(0)}) · 自身分位 · 相对 QQQ 价差`) : "";

  // IV term(自身分位)
  let termTile = "";
  if (be.length >= 2 && be[0].atm_iv && be[be.length - 1].atm_iv) {
    const f = be[0].atm_iv, b = be[be.length - 1].atm_iv;
    const termSub = [f > b ? "backwrd" : "contango", pv(o.iv_term_pct)].filter(Boolean).join(" · ");
    termTile = tile("IV term", `${(f * 100).toFixed(0)}→${(b * 100).toFixed(0)}%`, termSub, "", "Front vs back ATM IV · 自身分位");
  }

  // VRP(IV − 20d 已实现波动,自身分位)
  const rv = realizedVol(d.bars_d, 20);
  let vrpTile = "";
  if (o.atm_iv && rv) {
    const vrp = o.atm_iv - rv;
    const vrpSub = [vrp > 0 ? "rich" : "cheap", pv(o.vrp_pct)].filter(Boolean).join(" · ");
    vrpTile = tile("VRP", `${vrp >= 0 ? "+" : ""}${(vrp * 100).toFixed(0)}pt`, vrpSub, vrp >= 0 ? "down" : "up", `ATM IV ${(o.atm_iv * 100).toFixed(0)}% − 20d RV ${(rv * 100).toFixed(0)}% · 自身分位`);
  }

  // PCR:vol / OI / prem 三种口径合并到一格
  const allV = Object.values(RESEARCH?.tickers || {}).map((x) => x.options?.pcr_vol).filter((v) => v != null);
  const rank = o.pcr_vol != null ? allV.filter((x) => x < o.pcr_vol).length + 1 : null;
  const pcrParts = [
    o.pcr_vol != null ? o.pcr_vol : null,
    o.pcr_oi != null ? o.pcr_oi : null,
    o.pcr_prem != null ? o.pcr_prem : null,
  ];
  const pcrTile = pcrParts.some((x) => x != null)
    ? tile("PCR", pcrParts.map((x) => x != null ? x : "—").join(" / "),
        `vol/OI/prem${o.pcr_vol_pct != null ? ` · ${pv(o.pcr_vol_pct)}` : ""}${rank != null ? ` · WL ${rank}/${allV.length}` : ""}`, "",
        "Put/Call ratio by volume / open interest / premium (low = call-heavy) · vol 自身分位 · watchlist 排名")
    : "";

  // Max Pain / Earnings
  const mpSub = [
    spot ? `${spot >= o.max_pain ? "+" : ""}${((spot / o.max_pain - 1) * 100).toFixed(1)}%` : "",
    o.maxpain_pin != null ? `pin ${o.maxpain_pin}` : "",
  ].filter(Boolean).join(" · ");
  const mpTile = o.max_pain != null ? tile("Max Pain", o.max_pain, mpSub, "", "Pin 磁吸可信度 0-100(gamma门×距离×到期×波动×OI)· <20 当噪声 / >45 才当目标") : "";
  const earnTile = d.earnings_days != null ? tile("Earnings", d.earnings_days + "d", mmdd(d.earnings_date), d.earnings_days <= 10 ? "down" : "", "IV-crush risk into earnings") : "";

  // 权利金:Call / Put / Net 合并到一格;Δ(自上次采集增量)单独一格
  const npCls = (o.net_premium ?? 0) >= 0 ? "up" : "down";
  const premTile = tile("Premium C/P",
    `<span class="up">${fmtMoney(o.call_premium)}</span> / <span class="down">${fmtMoney(o.put_premium)}</span>`,
    `net <span class="${npCls}">${fmtMoney(o.net_premium)}</span>`, "",
    "Call / Put premium and net (activity, not buy/sell direction)");
  const pd = o.prem_delta;
  const dTile = pd ? tile("Δ prem", `<span class="${pd.call >= 0 ? "up" : "down"}">C ${(pd.call >= 0 ? "+" : "") + fmtMoney(pd.call)}</span> / <span class="${pd.put >= 0 ? "up" : "down"}">P ${(pd.put >= 0 ? "+" : "") + fmtMoney(pd.put)}</span>`, "", "", "Premium increment since last collection") : "";
  const premTotal = (o.call_premium + o.put_premium) || 1, cw = (o.call_premium / premTotal * 100).toFixed(1);
  const cwInt = Math.round(o.call_premium / premTotal * 100);

  const expRows = be.map((e) => `<tr>
    <td>${mmdd(e.exp)}</td>
    <td><span class="up">${fmtMoney(e.call_premium)}</span>/<span class="down">${fmtMoney(e.put_premium)}</span></td>
    <td>${fmtNum(e.call_vol)}/${fmtNum(e.put_vol)}</td>
    <td>${fmtNum(e.call_oi)}/${fmtNum(e.put_oi)}</td>
    <td>${e.atm_iv != null ? (e.atm_iv * 100).toFixed(0) + "%" : "&mdash;"}</td></tr>`).join("");
  const oiRows = (o.oi_changes || []).map((c) => `<tr>
    <td>${mmdd(c.exp)}</td><td>${c.strike}</td>
    <td class="${c.side === "call" ? "up" : "down"}">${c.side === "call" ? "C" : "P"}</td>
    <td class="${c.delta >= 0 ? "up" : "down"}">${c.delta >= 0 ? "+" : ""}${fmtNum(c.delta)}</td></tr>`).join("");

  const body = `<div class="opt-grid">
    ${emTile}${ivTile}${skewTile}${termTile}${vrpTile}${pcrTile}${mpTile}${earnTile}${premTile}${dTile}
  </div>
    <div class="prem-bar" title="Call premium share: ${cwInt}% (Put ${100 - cwInt}%)"><div class="prem-call" style="width:${cw}%"></div></div>
    <div class="muted small">Premium = activity (not buy/sell) — read direction with OI change + Real(sampled) GEX.</div>
    ${(o.top_strikes || []).length ? `<details><summary class="muted small">Most active strikes today</summary>
      <table><tr><th>Exp</th><th>Strike</th><th>Side</th><th>Vol</th><th>OI</th><th>Prem</th></tr>${(o.top_strikes || []).map((t) => `<tr>
        <td>${mmdd(t.exp)}</td><td>${t.strike}</td><td class="${t.side === "call" ? "up" : "down"}">${t.side === "call" ? "C" : "P"}</td>
        <td>${fmtNum(t.vol)}</td><td>${fmtNum(t.oi)}</td><td>${fmtMoney(t.premium)}</td></tr>`).join("")}</table></details>` : ""}
    ${expRows ? `<details><summary class="muted small">By expiry (term detail)</summary>
      <table><tr><th>Exp</th><th>Prem C/P</th><th>Vol C/P</th><th>OI C/P</th><th>ATM IV</th></tr>${expRows}</table></details>` : ""}
    ${oiRows ? `<details><summary class="muted small">OI change — new positioning</summary>
      <table><tr><th>Exp</th><th>Strike</th><th>Side</th><th>&Delta;OI</th></tr>${oiRows}</table></details>`
      : `<div class="muted small">OI change shows after two collections</div>`}`;

  $("opt-panel").innerHTML = `<div class="card">${body}</div>`;
}

/* ---------- Portfolio(本地专用:券商持仓饼图 + 汇总磁贴 + 交易明细)---------- */
// 均匀色相生成,slice 任意数量都可区分(暗色主题友好)
const pfColor = (i, n) => `hsl(${Math.round(i * 360 / Math.max(n, 1))} 62% 58%)`;

/* 饼图:只画规模 ≥ PF_MIN_VALUE 的持仓,每块可点(data-sym)。value 取每块正数规模(多头=市值,
   空头=|市值|)决定占比;centerSub 是环心默认说明。环心默认显示本饼图总仓位(有符号市值合计),
   点中的票在本饼图时改显该票仓位、其余暗化;点中的票不在本饼图则该饼图保持显示总仓位。 */
function buildDonut(items, { value = (x) => x.mkt_value, centerSub, emptyMsg } = {}) {
  const slices = items.map((x) => ({ x, v: value(x) })).filter((o) => o.v >= PF_MIN_VALUE)
    .sort((a, b) => b.v - a.v);
  const total = slices.reduce((s, o) => s + o.v, 0);
  if (!slices.length || !total) return emptyMsg ? `<div class="muted small">${emptyMsg}</div>` : "";
  const dispTotal = slices.reduce((s, o) => s + o.x.mkt_value, 0);   // 有符号实际市值合计(空头为负)
  const selSlice = pfFilter ? slices.find((o) => o.x.sym === pfFilter) : null;  // 选中的票在本饼图里?
  const centerBig = fmtMoney(selSlice ? selSlice.x.mkt_value : dispTotal);
  const centerSmall = selSlice ? selSlice.x.sym : centerSub;
  const R = 88, r = 54, cx = 100, cy = 100, TAU = Math.PI * 2;
  const pt = (rad, a) => `${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`;
  let ang = -Math.PI / 2;
  const arcs = [], legend = [];
  slices.forEach((o, i) => {
    const s = o.x, frac = o.v / total, a0 = ang, a1 = ang + TAU * frac; ang = a1;
    const col = pfColor(i, slices.length), large = (a1 - a0) > Math.PI ? 1 : 0;
    const sel = pfFilter === s.sym, dim = selSlice && !sel;   // 仅当选中的票在本饼图时才暗化其余
    arcs.push(`<path class="pf-slice${sel ? " sel" : ""}" data-sym="${esc(s.sym)}" d="M${pt(R, a0)} A${R} ${R} 0 ${large} 1 ${pt(R, a1)} L${pt(r, a1)} A${r} ${r} 0 ${large} 0 ${pt(r, a0)} Z" fill="${col}" opacity="${dim ? 0.28 : 0.9}"${sel ? ' stroke="#e5e9f0" stroke-width="1.5"' : ""}><title>${esc(s.sym)}: ${fmtMoney(o.x.mkt_value)} (${(frac * 100).toFixed(1)}%)</title></path>`);
    legend.push(`<div class="pf-leg${sel ? " sel" : ""}" data-sym="${esc(s.sym)}"><span class="pf-sw" style="background:${col}"></span>${esc(s.sym)} <span class="muted">${(frac * 100).toFixed(0)}%</span></div>`);
  });
  return `<div class="pf-donut"><svg viewBox="0 0 200 200" width="200" height="200">${arcs.join("")}` +
    `<text x="100" y="97" text-anchor="middle" fill="#e5e9f0" font-size="15" font-weight="600">${centerBig}</text>` +
    (centerSmall ? `<text x="100" y="113" text-anchor="middle" fill="#8b96ad" font-size="10">${esc(centerSmall)}</text>` : "") +
    `</svg><div class="pf-legend">${legend.join("")}</div></div>`;
}

/* 整数美元格式(盈亏诊断用;fmtMoney 是 K/M/B 组合口径,几百块会显成 $0K)。 */
const usd = (v) => (v < 0 ? "−$" : "$") + Math.round(Math.abs(v)).toLocaleString("en-US");

/* 每笔已实现盈亏的分布直方图(红=亏/绿=盈,灰线=0,黄虚线=均值)。trades: [{d,s,k,p}]。 */
function buildHist(trades) {
  const ps = trades.map((t) => t.p);
  if (!ps.length) return `<div class="muted small">窗口内无平仓记录</div>`;
  const min = Math.min(...ps, 0), max = Math.max(...ps, 0), span = (max - min) || 1;
  const NB = 25, bw = span / NB, counts = new Array(NB).fill(0);
  for (const p of ps) counts[Math.min(NB - 1, Math.max(0, Math.floor((p - min) / bw)))]++;
  const maxc = Math.max(...counts, 1);
  const W = 480, H = 150, padL = 6, padR = 6, padT = 8, padB = 20, iw = W - padL - padR, ih = H - padT - padB;
  const xat = (v) => padL + (v - min) / span * iw;
  const mean = ps.reduce((a, b) => a + b, 0) / ps.length;
  const bars = counts.map((c, i) => {
    const bx = padL + i / NB * iw, wpx = iw / NB - 1, h = c / maxc * ih;
    const lo = min + i * bw, hi = min + (i + 1) * bw, col = (lo + hi) / 2 < 0 ? "#f87171" : "#34d399";
    return c ? `<rect x="${bx.toFixed(1)}" y="${(padT + ih - h).toFixed(1)}" width="${wpx.toFixed(1)}" height="${h.toFixed(1)}" fill="${col}" opacity="0.85"><title>[${usd(lo)}, ${usd(hi)}): ${c} 笔</title></rect>` : "";
  }).join("");
  const axis = (v, dy = 12) => `<text x="${Math.min(W - padR, Math.max(padL, xat(v)))}" y="${H - padB + dy}" fill="#8b96ad" font-size="9" text-anchor="middle">${usd(v)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">${bars}` +
    `<line x1="${xat(0).toFixed(1)}" y1="${padT}" x2="${xat(0).toFixed(1)}" y2="${padT + ih}" stroke="#8b96ad" stroke-width="1"/>` +
    `<line x1="${xat(mean).toFixed(1)}" y1="${padT}" x2="${xat(mean).toFixed(1)}" y2="${padT + ih}" stroke="#fbbf24" stroke-width="1" stroke-dasharray="3 2"><title>均值 ${usd(mean)}</title></line>` +
    axis(min) + axis(0) + axis(max) + `</svg>`;
}

/* 盈亏诊断块:窗口切换(YTD/3M/1M)+ 量化指标 tiles + 收益分布。仅对有完整历史数据的账户显示。 */
function buildPnlPanel() {
  if (!PNL || !PNL.accounts) return "";
  const aid = pfAccount
    ? (PNL.accounts[pfAccount] ? pfAccount : null)          // 选了某账户:有数据才显示,否则不显示
    : (PNL.accounts["_all"] ? "_all" : Object.keys(PNL.accounts)[0] || null);  // 全部:优先合并视图,否则唯一账户
  if (!aid) return "";
  const acc = PNL.accounts[aid];
  const win = acc.windows[pfPnlWin] ? pfPnlWin : Object.keys(acc.windows)[0];
  const m = acc.windows[win].metrics, trades = acc.windows[win].trades;
  const toggle = ["ytd", "3m", "1m"].filter((w) => acc.windows[w])
    .map((w) => `<button data-pw="${w}"${w === win ? ' class="active"' : ""}>${w.toUpperCase()}</button>`).join("");
  const skewTxt = m.skew == null ? "—" : `${m.skew > 0 ? "+" : ""}${m.skew}`;
  const tiles = [
    tile("净已实现", usd(m.net), `${m.n} 笔`, m.net >= 0 ? "up" : "down"),
    tile("胜率", `${(m.win_rate * 100).toFixed(0)}%`, `${m.wins}胜/${m.losses}亏`),
    tile("盈亏比", m.payoff != null ? m.payoff.toFixed(2) : "—", `均盈${usd(m.avg_win)} / 均亏${usd(m.avg_loss)}`, (m.payoff ?? 0) >= 1 ? "up" : "down", "平均盈利 ÷ 平均亏损;<1=靠胜率撑,>1=payoff 占优"),
    tile("偏度", skewTxt, m.skew == null ? "" : (m.skew < 0 ? "左尾·大亏拖累" : "右尾·大赢主导"), (m.skew ?? 0) >= 0 ? "up" : "down", "收益分布偏度;负=有大亏肥尾,正=有大赢肥尾"),
    tile("亏损集中度", m.loss_conc != null ? `${(m.loss_conc * 100).toFixed(0)}%` : "—", "最大输家占毛亏", (m.loss_conc ?? 0) > 0.5 ? "down" : "", "单只票占全部亏损的比例;越高=亏损越集中在一只"),
    tile("期望/笔", usd(m.expectancy), "每笔平均", m.expectancy >= 0 ? "up" : "down"),
    tile("波动率", m.vol_daily != null ? usd(m.vol_daily) : "—", "日已实现P&L σ", "", "日已实现盈亏的标准差(美元);衡量每日盈亏波动大小"),
    tile("Sharpe", m.sharpe != null ? m.sharpe.toFixed(2) : "—", "年化·日P&L口径", (m.sharpe ?? 0) >= 1 ? "up" : "", "基于日已实现$P&L,超额=日均P&L−每日$门槛(账户资本×15%年化/252),÷日σ×√252;非账户%收益 Sharpe,勿与标准 Sharpe 直接比较"),
    tile("Sortino", m.sortino != null ? m.sortino.toFixed(2) : "—", "年化·仅下行", (m.sortino ?? 0) >= 1 ? "up" : "", "同 Sharpe(MAR=15%年化门槛),但分母只用低于门槛的下行波动"),
    tile("最大回撤", m.max_dd != null ? usd(m.max_dd) : "—", "已实现累计峰谷", (m.max_dd ?? 0) < 0 ? "down" : "", "已实现盈亏累计曲线从峰值的最大回落(美元)"),
  ].join("");
  return `<details open class="pf-pnl"><summary class="muted small">📊 盈亏诊断 · ${esc(acc.label)} <span class="muted">(已实现,截至 ${esc(PNL.as_of)})</span></summary>
      <div class="pf-pnl-bar"><div class="chips seg" id="pf-pw">${toggle}</div><span class="muted small">无风险收益为 ${(((PNL && PNL.risk_free_annual) || 0) * 100).toFixed(0)}%</span></div>
      <div class="opt-grid">${tiles}</div>
      <div class="pf-hist">${buildHist(trades)}</div></details>`;
}

function renderPortfolio() {
  const el = $("portfolio");
  if (!el) return;
  const p = PORTFOLIO;
  const allPos = (p?.positions || []).filter((x) => x.mkt_value != null);
  if (!allPos.length) {
    pfFilter = null; pfAccount = null;
    el.innerHTML = `<div class="card empty">暂无持仓数据 — 认证券商后跑 <code>scripts/build_portfolio.py</code> 生成 <code>data/portfolio.json</code>。</div>`;
    return;
  }
  // 账户下拉:>1 个账户才显示;选中的账户已不存在(数据变了)则回退到全部
  const accounts = p.accounts || [];
  if (pfAccount && !accounts.some((a) => a.id === pfAccount)) pfAccount = null;
  const pos = pfAccount ? allPos.filter((x) => x.account === pfAccount) : allPos;
  const acctSel = accounts.length > 1
    ? `<select id="pf-acct" class="pf-acct"><option value=""${pfAccount ? "" : " selected"}>全部账户</option>`
      + accounts.map((a) => `<option value="${esc(a.id)}"${pfAccount === a.id ? " selected" : ""}>${esc(a.label || a.id)}</option>`).join("")
      + `</select>`
    : "";
  const acctBar = acctSel ? `<div class="pf-acctbar"><span class="muted small">账户</span>${acctSel}</div>` : "";
  const curAcct = pfAccount ? (accounts.find((a) => a.id === pfAccount)?.label || pfAccount)
    : (accounts.length > 1 ? `全部 ${accounts.length} 户` : ((p.brokers || []).join("/") || "—"));
  const total = pos.reduce((s, x) => s + x.mkt_value, 0);
  const pnl = pos.reduce((s, x) => s + (x.pnl || 0), 0);
  const cost = total - pnl;
  const tiles = [
    tile("总市值", fmtMoney(total)),
    tile("未实现盈亏", `${pnl >= 0 ? "+" : ""}${fmtMoney(pnl)}`, cost ? `${(pnl / cost * 100).toFixed(1)}%` : "", pnl >= 0 ? "up" : "down"),
    tile("持仓数", String(pos.length)),
    tile("账户", curAcct),
    tile("更新", p.updated_at ? fmtDT(p.updated_at) : "—"),
  ].join("");
  let txns = p.transactions || [];
  if (pfAccount) txns = txns.filter((t) => t.account === pfAccount);
  if (pfFilter) txns = txns.filter((t) => t.sym === pfFilter);
  // 分页:每页 PF_TX_PAGE 条;filter 变化后当前页可能越界,夹回有效范围
  const txTotal = txns.length;
  const txPages = Math.max(1, Math.ceil(txTotal / PF_TX_PAGE));
  pfTxPage = Math.min(Math.max(pfTxPage, 0), txPages - 1);
  const pageStart = pfTxPage * PF_TX_PAGE;
  const pageTxns = txns.slice(pageStart, pageStart + PF_TX_PAGE);
  const chip = pfFilter
    ? `<button id="pf-clear" class="pf-chip">筛选 ${esc(pfFilter)} <span class="muted">✕</span></button>`
    : `<span class="muted small">点饼图某块 → 只看该票交易</span>`;
  const txRows = pageTxns.map((t) => {
    // 持仓变化:买入(含 buy_to_cover)+qty、卖出(含 sell_short)-qty,即该笔对仓位的净份额影响
    const delta = t.side === "buy" ? t.qty : t.side === "sell" ? -t.qty : null;
    return `<tr>
      <td>${t.ts ? fmtDT(t.ts) : "—"}</td><td>${t.kind === "option" ? "期权" : "正股"}</td><td>${esc(t.sym || "")}</td>
      <td class="${t.side === "buy" ? "up" : t.side === "sell" ? "down" : ""}">${esc(t.side || "—")}</td>
      <td>${t.qty != null ? fmtNum(t.qty) : "—"}</td><td>${t.price != null ? "$" + t.price : "—"}</td>
      <td class="${delta > 0 ? "up" : delta < 0 ? "down" : ""}">${delta != null ? (delta > 0 ? "+" : "") + fmtNum(delta) : "—"}</td></tr>`;
  }).join("");
  const pager = txPages > 1
    ? `<div class="pf-pager">
         <button class="mini-btn" data-pfpage="prev"${pfTxPage === 0 ? " disabled" : ""}>‹ 上一页</button>
         <span class="muted small">${pageStart + 1}–${pageStart + pageTxns.length} / ${txTotal} · 第 ${pfTxPage + 1}/${txPages} 页</span>
         <button class="mini-btn" data-pfpage="next"${pfTxPage >= txPages - 1 ? " disabled" : ""}>下一页 ›</button>
       </div>`
    : "";
  const txTable = `<details><summary class="muted small">交易明细 (${txTotal})</summary>
       <div class="pf-txhead">${chip}</div>
       ${txTotal ? `<table class="bt-table"><tr><th>时间</th><th>种类</th><th>代码</th><th>方向</th><th>数量</th><th>价格</th><th>持仓变化</th></tr>${txRows}</table>${pager}`
    : `<div class="muted small">${pfFilter ? esc(pfFilter) + " 无交易记录" : "无交易记录"}</div>`}</details>`;
  // 多头饼图(市值) + 空头饼图(按 |市值|,有做空仓位才显示)。标题右侧显示该饼图总仓位。
  // 全部账户时同一股票会来自多个账户 → 画饼前按 sym 合并(市值/盈亏/数量相加),避免同票裂成多块。
  const bySym = new Map();
  for (const x of pos) {
    const e = bySym.get(x.sym);
    if (e) { e.mkt_value += x.mkt_value; e.pnl = (e.pnl || 0) + (x.pnl || 0); e.qty = (e.qty || 0) + (x.qty || 0); }
    else bySym.set(x.sym, { sym: x.sym, mkt_value: x.mkt_value, pnl: x.pnl, qty: x.qty });
  }
  const mergedPos = [...bySym.values()];
  const longs = mergedPos.filter((x) => x.mkt_value > 0);
  const shorts = mergedPos.filter((x) => x.mkt_value < 0);
  const K = `≥$${(PF_MIN_VALUE / 1000).toFixed(0)}K`;
  const longTotal = longs.filter((x) => x.mkt_value >= PF_MIN_VALUE).reduce((s, x) => s + x.mkt_value, 0);
  const shortTotal = shorts.filter((x) => -x.mkt_value >= PF_MIN_VALUE).reduce((s, x) => s + x.mkt_value, 0);
  const cap = (name, tot) => `<div class="pf-pie-cap muted small">${name} <span class="pf-cap-tot">${fmtMoney(tot)}</span></div>`;
  const longBox = `<div class="pf-pie">${cap("多头", longTotal)}`
    + `${buildDonut(longs, { centerSub: K, emptyMsg: `无 ${K} 的持仓可画饼图` })}</div>`;
  const donuts = shorts.length
    ? `<div class="pf-pies">${longBox}`
      + `<div class="pf-pie">${cap("空头", shortTotal)}`
      + `${buildDonut(shorts, { value: (x) => -x.mkt_value, centerSub: K, emptyMsg: `无 ${K} 的做空仓位` })}</div>`
      + `</div>`
    : `<div class="pf-pies">${longBox}</div>`;
  el.innerHTML = `<div class="card">${acctBar}<div class="opt-grid">${tiles}</div>${donuts}${buildPnlPanel()}${txTable}</div>`;
}

/* ---------- 错误 ---------- */
function renderErrors() {
  const msgs = [...(RESEARCH?.errors || []), ...(GEX?.errors || [])];
  $("errors").innerHTML = msgs.length
    ? `<details><summary>⚠️ ${msgs.length} data-source notice(s)</summary><ul>${msgs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></details>` : "";
}

/* ---------- 标的分组(卡片开关直接改 CFG,防抖写回仓库) ---------- */
let cfgStatus = "";
let saveTimer = null;

function updateCfgStatus() {
  const el = $("cfg-status");
  if (el) el.innerHTML = cfgStatus;
}

async function loadCfg() {
  // 读最新提交(contents API),而非 Pages 静态副本——config 提交在 main,
  // 而 Pages 仅手动重部署,否则 PAT 同步后刷新会读到旧配置、新加的 ticker "消失"。
  const cfg = await loadFreshJSON("config/tickers.json") || {};
  // 本机未保存的改动(add/remove/分组)存 localStorage,优先于 repo,防刷新丢失
  const local = JSON.parse(localStorage.getItem("wbCfgPending") || "null");
  const wl = local?.watchlist?.length ? local.watchlist : [...(cfg.watchlist || [])];
  const dp = local?.deep || cfg.deep || cfg.watchlist || [];
  CFG.watchlist = wl;
  CFG.deep = dp.filter((t) => wl.includes(t));
}

function scheduleSave() {
  // 立刻存本机(不依赖 PAT,刷新不丢);再防抖写 repo
  localStorage.setItem("wbCfgPending", JSON.stringify({ watchlist: CFG.watchlist, deep: CFG.deep }));
  cfgStatus = "Pending save…"; updateCfgStatus();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCfg, 1500);  // 防抖:连续切换合并成一次提交
}

async function saveCfg() {
  const pat = getPat() || $("gex-pat").value.trim();
  const watchlist = [...new Set(CFG.watchlist)];
  const deep = [...new Set(CFG.deep)].filter((t) => watchlist.includes(t));
  if (!pat) { cfgStatus = "⚠️ Saved on THIS device only. To sync (so data actually loads for new tickers), enter a PAT with Contents read/write in the Collection panel below."; updateCfgStatus(); return; }
  const body = { "_note": "Single source of truth for tickers; edited via the D/Q toggles and add/remove on the trading-desk mini cards.", watchlist, deep };
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(body, null, 2) + "\n")));
  cfgStatus = "Saving…"; updateCfgStatus();
  try {
    const meta = await fetch(`https://api.github.com/repos/${REPO}/contents/config/tickers.json`, { headers: ghHeaders(pat) });
    const sha = meta.ok ? (await meta.json()).sha : undefined;
    const r = await fetch(`https://api.github.com/repos/${REPO}/contents/config/tickers.json`, {
      method: "PUT", headers: ghHeaders(pat),
      body: JSON.stringify({ message: "chore: update ticker groups via UI", content, sha, branch: "main" }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.json())?.message || ""}`);
    localStorage.removeItem("wbCfgPending");  // 已同步到 repo,清本机暂存,让 repo 成为权威
    cfgStatus = `✅ Synced (watchlist ${watchlist.length}); new tickers get data on the next collection run`;
  } catch (e) {
    cfgStatus = `❌ Save failed: ${esc(e.message)} (PAT needs Contents read/write)`;
  }
  updateCfgStatus();
}

/* ---------- 采集控制(GitHub Actions API) ---------- */
function setGexStatus(msg) { $("gex-status").innerHTML = msg; }

async function refreshRunStatus() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/gex.yml/runs?per_page=1&t=${Date.now()}`);
    if (!r.ok) throw new Error(r.status);
    const run = (await r.json()).workflow_runs?.[0];
    if (!run) { setGexStatus("Collection: no run yet"); return; }
    const state = run.status === "completed"
      ? (run.conclusion === "success" ? "✅ done" : run.conclusion === "cancelled" ? "⏹ stopped" : "❌ " + run.conclusion)
      : "🟢 running";
    setGexStatus(`Collection: ${state} · started ${fmtDT(run.created_at)} · <a href="${run.html_url}" target="_blank" rel="noopener">logs</a>`);
  } catch { setGexStatus("Collection: query failed (rate-limited, try later)"); }
}

async function dispatchSession(inputs, label) {
  const pat = $("gex-pat").value.trim();
  if (!pat) { setGexStatus("⚠️ GitHub PAT required (fine-grained, repo Actions read/write only)"); return; }
  setPat(pat); startPolling();
  setGexStatus(`Starting ${label}…`);
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/gex.yml/dispatches`, {
      method: "POST", headers: ghHeaders(pat), body: JSON.stringify({ ref: "main", inputs }),
    });
    if (r.status !== 204) throw new Error(`HTTP ${r.status}: ${(await r.json())?.message || ""}`);
    setGexStatus(`✅ ${label} started, refreshing status shortly…`);
    setTimeout(refreshRunStatus, 5000);
  } catch (e) { setGexStatus(`❌ Start failed: ${esc(e.message)} (check PAT permissions)`); }
}

function initControls() {
  $("gex-pat").value = getPat();
  // 粘贴/修改 PAT 即保存(仅本机 localStorage),自动轮询提速到 60 秒
  $("gex-pat").addEventListener("change", () => {
    setPat($("gex-pat").value.trim());
    startPolling();
    refreshData();
  });
  $("gex-start-btn").addEventListener("click", () => dispatchSession({}, "rolling session"));
  $("gex-once-btn").addEventListener("click", () => dispatchSession({ once: "true" }, "single round"));
  $("gex-stop-btn").addEventListener("click", async () => {
    const pat = $("gex-pat").value.trim();
    if (!pat) { setGexStatus("⚠️ Stop requires PAT"); return; }
    setGexStatus("Stopping…");
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/gex.yml/runs?status=in_progress&t=${Date.now()}`);
      const runs = (await r.json()).workflow_runs || [];
      if (!runs.length) { setGexStatus("No collection running"); return; }
      for (const run of runs) {
        await fetch(`https://api.github.com/repos/${REPO}/actions/runs/${run.id}/cancel`, { method: "POST", headers: ghHeaders(pat) });
      }
      setGexStatus(`✅ Requested stop of ${runs.length} run(s)`);
      setTimeout(refreshRunStatus, 5000);
    } catch (e) { setGexStatus(`❌ Stop failed: ${esc(e.message)}`); }
  });
}

/* ---------- 数据加载与轮询 ---------- */
// bars_intraday.json ~8.8MB 且 K线变化慢:与 GEX 轮询解耦,最多每 BARS_MIN_MS 拉一次
// (GEX/flow 每轮拉;bars 首次/手动刷新/超过间隔才拉)。省带宽 & 加载延迟。
let lastBarsAt = 0;
const BARS_MIN_MS = 120_000;
async function loadData(force = false) {
  const wantBars = force || !BARS || (Date.now() - lastBarsAt >= BARS_MIN_MS);
  const [research, gex, gexh, week, bars] = await Promise.all([
    loadFreshJSON("data/research.json"),
    loadFreshJSON("data/gex.json"),
    loadFreshJSON("data/gex_history.json"),
    loadFreshJSON("data/gex_week.json"),
    wantBars ? loadFreshJSON("data/bars_intraday.json") : Promise.resolve(null),
  ]);
  RESEARCH = research; GEX = gex; GEXH = gexh; WEEK = week;
  if (wantBars && bars) { BARS = bars; lastBarsAt = Date.now(); }  // 拉失败保留旧 bars,下轮重试
  // 券商持仓:本地专用文件(gitignored)。用 loadJSON 相对路径 → localhost 有、公开站 404→null。
  PORTFOLIO = await loadJSON("data/portfolio.json");
  PNL = await loadJSON("data/pnl.json");   // 盈亏诊断(公开);缺失则面板不显示该块
  SCORES = parseCSV(await loadText("research/scorecards/_summary.csv"));  // 打分总表(本地符号链接→私有库);公开站404→null
}

/* 简易 fetch 文本 + CSV 解析(处理引号内逗号、BOM);失败→null */
async function loadText(path) {
  try { const r = await fetch(path + "?t=" + Date.now()); if (!r.ok) throw 0; return await r.text(); }
  catch { return null; }
}
function parseCSV(text) {
  if (text == null) return null;
  text = text.replace(/^\uFEFF/, "");
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}

/* ---------- Scorecards(解析 _summary.csv,热力表;风格同交易台)---------- */
function renderScorecards() {
  const el = $("scorecards"); if (!el) return;
  const rows = SCORES;
  if (!rows || rows.length < 2) { el.innerHTML = ""; return; }  // 公开站/无文件 → 不显示
  const head = rows[0];
  const SCORE_COLS = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10]);   // 8 features + Total,均 0–10
  const heat = (v) => {
    const s = parseFloat(v); if (isNaN(s)) return "";
    const m = Math.min(Math.abs(s), 5) / 5;          // 0..1 深浅(幅度)
    const hue = s >= 0 ? 142 : 0;                     // 正=绿 / 负=红,无黄
    const a = (0.05 + m * 0.37).toFixed(2);           // 0≈透明 → ±5 最深
    return ` style="background:hsl(${hue} 65% 45% / ${a})"`;
  };
  const th = head.map((h) => `<th>${esc(h === "PositionCheck" ? "Position Check" : h)}</th>`).join("");
  let seenShort = false;
  const body = rows.slice(1).filter((r) => r.length > 1 && r[0]).map((r) => {
    const dir = r[1];
    const isShort = dir === "Short";
    const split = isShort && !seenShort; if (isShort) seenShort = true;
    const dirCls = dir === "Short" ? "down" : dir === "Long" ? "up" : "muted";
    const dirTxt = dir === "Short" ? "空" : dir === "Long" ? "多" : "观";  // Watch=无仓位
    const chk = r[11] || "";
    const chkCls = chk.includes("弱") ? "down" : chk.startsWith("ok") ? "up" : "muted";
    const tds = r.map((v, i) => {
      if (i === 0) return `<td class="sc-tk"><b>${esc(v)}</b></td>`;
      if (i === 1) return `<td><span class="sc-dir ${dirCls}">${dirTxt}</span></td>`;
      if (i === 11) return `<td class="${chkCls} sc-chk">${esc(v)}</td>`;
      if (SCORE_COLS.has(i)) return `<td class="sc-num"${heat(v)}>${esc(v)}</td>`;
      return `<td>${esc(v)}</td>`;
    }).join("");
    return `<tr${split ? ' class="sc-split"' : ""}>${tds}</tr>`;
  }).join("");
  el.innerHTML = `<div class="card"><div class="sc-head"><b>📊 Scorecards</b> `
    + `<span class="muted small">本地 · 8-feature 打分(-5~+5 看多吸引力,0=中性/正=好负=差,格式 现状/前瞻)。多头看高、空头看低;★项需当前数据校准</span></div>`
    + `<div class="sc-wrap"><table class="bt-table sc-table"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div></div>`;
}

function renderAll(keepRange = false) {
  const lr = keepRange ? chart.timeScale().getVisibleLogicalRange() : null;
  renderMiniCards();
  renderStats();
  renderChart();
  renderGexSub();
  renderOptPanel();
  renderPortfolio();
  renderScorecards();
  renderErrors();
  if (lr) chart.timeScale().setVisibleLogicalRange(lr);
  const upd = RESEARCH?.updated_at || GEX?.updated_at;
  $("poll-status").textContent = (upd ? `Data ${fmtDT(upd)}` : "No data")
    + ` · auto-refresh (${marketWindow() ? (getPat() ? "20s" : "2m, add PAT to speed up") : "off-hours 15m"})`;
}

async function refreshData(force = false) {
  await loadData(force);
  renderAll(true);
  refreshRunStatus();
  startPolling(); // 每次刷新后按当前时段重排下一次
}

/* 时段感知轮询:盘中(ET 9:25-16:10 工作日)60秒(PAT)/5分钟(匿名);盘外 30 分钟 */
function marketWindow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET, hourCycle: "h23", weekday: "short", hour: "numeric", minute: "numeric",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  if (["Sat", "Sun"].includes(get("weekday"))) return false;
  const mins = parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10);
  return mins >= 9 * 60 + 25 && mins <= 16 * 60 + 10;
}

function startPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  const iv = marketWindow() ? (getPat() ? 20_000 : 120_000) : 900_000;
  pollTimer = setTimeout(refreshData, iv);
}

/* ---------- 交互绑定 ---------- */
function initToolbar() {
  $("mini-cards").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const { act, sym } = btn.dataset;
    if (act === "pick") {
      SYM = sym; localStorage.setItem("wbSym", SYM); ladderDay = null; renderAll();  // 换票回 Live
    } else if (act === "deep") {
      if (!CFG.deep.includes(sym)) CFG.deep.push(sym);
      scheduleSave(); renderMiniCards(); renderAll();
    } else if (act === "wl") {
      CFG.deep = CFG.deep.filter((x) => x !== sym);
      scheduleSave(); renderMiniCards(); renderAll();
    } else if (act === "del") {
      CFG.watchlist = CFG.watchlist.filter((x) => x !== sym);
      CFG.deep = CFG.deep.filter((x) => x !== sym);
      if (SYM === sym) SYM = null;
      scheduleSave(); renderMiniCards(); renderAll();
    }
  });
  // 末尾添加框:回车加入(全量普通组待遇,同时进 deep 保持一致)
  $("mini-cards").addEventListener("keydown", (ev) => {
    if (ev.target.id !== "mc-add-input" || ev.key !== "Enter") return;
    const t = ev.target.value.trim().toUpperCase().replace(/[^A-Z0-9.]/g, "");
    if (t && !CFG.watchlist.includes(t)) {
      CFG.watchlist.push(t);
      if (!CFG.deep.includes(t)) CFG.deep.push(t);
      SYM = t; localStorage.setItem("wbSym", t);
      scheduleSave(); renderMiniCards(); renderAll();
    }
  });
  $("tf-chips").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    TF = btn.dataset.tf;
    localStorage.setItem("wbTf", TF);
    [...$("tf-chips").children].forEach((b) => b.classList.toggle("active", b === btn));
    renderChart();
  });
  $("ladder-mode").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    ladderMode = btn.dataset.m;
    [...$("ladder-mode").children].forEach((b) => b.classList.toggle("active", b === btn));
    renderLadder();
  });
  $("gex-exp").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    gexBucket = btn.dataset.b;
    localStorage.setItem("wbGexBucket", gexBucket);
    [...$("gex-exp").children].forEach((b) => b.classList.toggle("active", b === btn));
    if (ladderMode !== "gex") { ladderMode = "gex"; [...$("ladder-mode").children].forEach((b) => b.classList.toggle("active", b.dataset.m === "gex")); }
    renderStats();
    renderChart();     // flip 线随桶更新
    renderGexSub();    // sparkline 随桶更新
    renderLadder();
  });
  $("gex-caliber").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    gexCaliber = btn.dataset.c;
    localStorage.setItem("wbGexCaliber", gexCaliber);
    [...$("gex-caliber").children].forEach((b) => b.classList.toggle("active", b === btn));
    if (ladderMode !== "gex") { ladderMode = "gex"; [...$("ladder-mode").children].forEach((b) => b.classList.toggle("active", b.dataset.m === "gex")); }
    renderStats();
    renderChart();
    renderGexSub();
    renderLadder();
  });
  // 叠加层勾选:切某条线可见性
  $("overlay-chips").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    const k = btn.dataset.ov;
    overlayOn[k] = overlayOn[k] === false;  // toggle(默认 true)
    localStorage.setItem("wbOverlays", JSON.stringify(overlayOn));
    btn.classList.toggle("active", overlayOn[k] !== false);
    applyOverlayVis();
  });
  // Anchored VWAP 锚点
  $("avwap-ctrl").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    if (btn.dataset.a === "add") {
      avwapAdd = !avwapAdd;
      localStorage.setItem("wbAvwapAdd", avwapAdd ? "1" : "0");
      btn.classList.toggle("active", avwapAdd);
      $("chart").style.cursor = avwapAdd ? "crosshair" : "";
    } else if (btn.dataset.a === "clear") {
      delete avwapAnchors[SYM];
      localStorage.setItem("wbAvwap", JSON.stringify(avwapAnchors));
      renderChart();
    }
  });
  // 会话:RTH(默认)/ +ETH(含盘前盘后)
  $("session-chips").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    showETH = btn.dataset.s === "eth";
    localStorage.setItem("wbShowETH", showETH ? "1" : "0");
    [...$("session-chips").children].forEach((b) => b.classList.toggle("active", b === btn));
    renderChart();
  });
  // Portfolio 饼图/图例点击 → 交易明细按该票 filter(再点同块或 ✕ 清除);交易明细翻页。委托到常驻容器 #portfolio。
  $("portfolio").addEventListener("click", (ev) => {
    const pwBtn = ev.target.closest("#pf-pw button");
    if (pwBtn) { pfPnlWin = pwBtn.dataset.pw; renderPortfolio(); return; }
    const pageBtn = ev.target.closest("[data-pfpage]");
    if (pageBtn) { pfTxPage += pageBtn.dataset.pfpage === "next" ? 1 : -1; renderPortfolio(); return; }
    if (ev.target.closest("#pf-clear")) { pfFilter = null; pfTxPage = 0; renderPortfolio(); return; }
    const hit = ev.target.closest("[data-sym]");
    if (!hit) return;
    const sym = hit.dataset.sym;
    pfFilter = (pfFilter === sym) ? null : sym;   // 点已选中的 → 取消
    pfTxPage = 0;                                 // 换筛选回到第 1 页
    renderPortfolio();
  });
  // Portfolio 账户下拉 → 切换当前查看的账户(切账户时清掉个股 filter、回到第 1 页)
  $("portfolio").addEventListener("change", (ev) => {
    if (!ev.target.closest("#pf-acct")) return;
    pfAccount = ev.target.value || null;
    pfFilter = null;
    pfTxPage = 0;
    renderPortfolio();
  });
  // 本周历史 GEX 快照:选某日看当日墙(当周到期);data-day="" = Live/最新
  $("gex-week-chips").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    ladderDay = btn.dataset.day || null;
    renderLadder();   // 内部 renderWeekChips 更新高亮
  });
  $("refresh-btn").addEventListener("click", () => refreshData(true));  // 手动刷新强制拉最新 bars
  renderOverlayChips();
  [...$("gex-caliber").children].forEach((b) => b.classList.toggle("active", b.dataset.c === gexCaliber));
  $("avwap-ctrl").querySelector('[data-a="add"]').classList.toggle("active", avwapAdd);
  if (avwapAdd) $("chart").style.cursor = "crosshair";
  [...$("session-chips").children].forEach((b) => b.classList.toggle("active", (b.dataset.s === "eth") === showETH));
}

/* ---------- 入口 ---------- */
(async function main() {
  initCharts();
  initToolbar();
  initControls();
  [...$("tf-chips").children].forEach((b) => b.classList.toggle("active", b.dataset.tf === TF));
  await loadCfg();       // 标的分组只在启动时载入,避免轮询覆盖未保存的改动
  await loadData();
  renderAll();
  refreshRunStatus();
  startPolling();
})();
