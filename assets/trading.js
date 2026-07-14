/* 交易台 — 单票工作台:K线主图 + 共享价格轴行权价梯 + 期权面板 + 采集控制
   图表库: TradingView lightweight-charts v4(CDN,全局 LightweightCharts) */
import {
  $, esc, fmtDT, fmtMoney, fmtNum, REPO, loadJSON, loadFreshJSON, getPat, setPat, ghHeaders,
} from "./shared.js";

const LWC = window.LightweightCharts;
const ET = "America/New_York";

let RESEARCH = null, GEX = null, GEXH = null;
let CFG = { watchlist: [], deep: [] };  // 标的分组,来自 config/tickers.json,卡片开关就地编辑
let SYM = localStorage.getItem("wbSym") || null;
let TF = localStorage.getItem("wbTf") || "5m";
let ladderMode = "gex";
let gexBucket = localStorage.getItem("wbGexBucket") || "0dte";  // GEX 到期范围,默认 0DTE
let gexCaliber = localStorage.getItem("wbGexCaliber") || "nominal";  // 名义 / 流量
const GEX_BUCKET_ORDER = ["0dte", "week", "2wk", "all"];
const GEX_BUCKET_LABEL = { "0dte": "0DTE", week: "This Week", "2wk": "≤14d", all: "All" };
let chart, candles, volume, ema9L, ema21L, vwapL, bbU, bbL, vsU, vsL, subChart, gexLine;
let hoverLevels = [];       // flip / MaxPain 横线的 {name,color,price},供 hover 识别
let hoverSeries = [];       // 叠加曲线的 {series,name,color},供 hover 识别
let priceLines = [];
let pollTimer = null;
let ladderRetry = 0;  // 首屏梯子重试计数(坐标系就绪前 priceToCoordinate 返回 null)

/* lightweight-charts 按 UTC 显示,把时间戳平移成本地时间 */
const tconv = (ms) => Math.floor(ms / 1000) - new Date(ms).getTimezoneOffset() * 60;
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: ET });

/* ---------- 数据变换 ---------- */
function researchOf(sym) { return RESEARCH?.tickers?.[sym] || {}; }

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

function barsFor(sym, tf) {
  const d = researchOf(sym);
  if (tf === "1m") return d.bars_1m || [];
  if (tf === "5m") return d.bars_5m || [];
  if (tf === "15m") return aggregate(d.bars_5m || [], 3);
  return d.bars_d || [];
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

const lastClose = (sym) => {
  const b = researchOf(sym).bars_1m || researchOf(sym).bars_5m || [];
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
  const buckets = t.buckets;
  if (!buckets) return { ...t, bucket: "all", fallback: false, caliber: "nominal", flowMiss };
  const cal = gexCaliber === "flow" && t0.flow ? "flow" : "nominal";
  const nonEmpty = (b) => b && b.by_strike && b.by_strike.length;
  const conf = { classified: t.classified, coverage: t.coverage, ambiguity: t.ambiguity };
  const start = GEX_BUCKET_ORDER.indexOf(gexBucket);
  for (let i = start; i < GEX_BUCKET_ORDER.length; i++) {
    const name = GEX_BUCKET_ORDER[i];
    if (nonEmpty(buckets[name])) return { spot: t.spot, ...buckets[name], bucket: name, fallback: i !== start, caliber: cal, flowMiss, ...conf };
  }
  return { spot: t.spot, ...(buckets[gexBucket] || { net_gex: 0, flip: null, by_strike: [] }), bucket: gexBucket, fallback: false, caliber: cal, flowMiss, ...conf };
}

/* ---------- 图表初始化 ---------- */
const chartTheme = {
  layout: { background: { color: "transparent" }, textColor: "#8b96ad", fontSize: 11 },
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

  subChart = LWC.createChart($("gex-sub"), { ...chartTheme, timeScale: { ...chartTheme.timeScale, timeVisible: true } });
  gexLine = subChart.addLineSeries({ color: "#60a5fa", lineWidth: 2, priceFormat: { type: "custom", formatter: (v) => (v / 1e6).toFixed(0) + "M" } });

  // 直接调用(不裹 rAF):后台标签页 rAF 会被节流不触发。
  // subscribeVisibleLogicalRangeChange 在图表坐标就绪后才触发,是最可靠的重画时机。
  chart.timeScale().subscribeVisibleLogicalRangeChange(renderLadder);
  const ro = new ResizeObserver(renderLadder);  // 首屏 flex 宽度就绪后重画
  ro.observe($("chart"));
  ro.observe($("ladder-box"));
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
  const bars = barsFor(SYM, TF);
  const daily = TF === "1d";
  const t = (b) => daily ? etDay(b[0]) : tconv(b[0]);
  candles.setData(bars.map((b) => ({ time: t(b), open: b[1], high: b[2], low: b[3], close: b[4] })));
  volume.setData(bars.map((b) => ({ time: t(b), value: b[5], color: b[4] >= b[1] ? "#34d39955" : "#f8717155" })));
  const closes = bars.map((b) => b[4]);
  const line = (vals) => vals.map((v, i) => v == null ? null : ({ time: t(bars[i]), value: v })).filter(Boolean);
  ema9L.setData(line(ema(closes, 9)));
  ema21L.setData(line(ema(closes, 21)));
  vwapL.setData(daily ? [] : line(vwapPerDay(bars)));
  // 布林带 BB(20,2)
  const bb = bollinger(closes, 20, 2);
  bbU.setData(line(bb.up)); bbL.setData(line(bb.lo));
  // VWAP ±1σ 带(仅盘中)
  if (daily) { vsU.setData([]); vsL.setData([]); }
  else { const vb = vwapBands(bars, 1); vsU.setData(line(vb.up)); vsL.setData(line(vb.lo)); }

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
  renderLadder();  // setVisibleLogicalRange 也会触发上面的 subscribe 兜底
}

/* ---------- 盘中净 GEX 副图(按所选到期桶) ---------- */
function renderGexSub() {
  const pts = (GEXH?.points || []).filter((p) => p.sym === SYM);
  gexLine.setData(pts.map((p) => ({
    time: tconv(Date.parse(p.t)),
    value: (p.nets && p.nets[gexBucket] != null) ? p.nets[gexBucket] : p.net,
  })));
  subChart.timeScale().fitContent();
}

/* ---------- 行权价梯(与主图共享价格轴) ---------- */
function ladderRows() {
  if (ladderMode === "gex") {
    return (gexBucketData(SYM)?.by_strike || []).map((r) => ({ strike: r.strike, a: r.net, b: 0, net: true }));
  }
  const key = ladderMode === "oi" ? "oi" : "vol";
  return (researchOf(SYM).options?.by_strike || []).map((r) => ({
    strike: r.strike, a: r[`call_${key}`] || 0, b: r[`put_${key}`] || 0, net: false,
  }));
}

function updateLadderTitle() {
  const m = { gex: "GEX", oi: "OI", vol: "Volume" }[ladderMode];
  let suffix;
  if (ladderMode === "gex") {
    const b = gexBucketData(SYM);
    const cal = b?.caliber === "flow" ? "·Flow" : gexCaliber === "flow" ? "·Flow N/A→Nominal" : "";
    suffix = ` (${GEX_BUCKET_LABEL[b?.bucket] || GEX_BUCKET_LABEL[gexBucket]}${b?.fallback ? "·nearest" : ""}${cal})`;
  } else {
    suffix = " · all expiries";
  }
  $("ladder-title").textContent = `Strike Ladder · ${m}${suffix}`;
  $("gex-exp").style.opacity = ladderMode === "gex" ? "1" : "0.4";
  $("gex-caliber").style.opacity = ladderMode === "gex" ? "1" : "0.4";
}

function renderLadder() {
  const svg = $("ladder");
  if (!svg || !candles) return;
  updateLadderTitle();
  const rows = ladderRows();
  const box = $("ladder-box").getBoundingClientRect();
  const H = $("chart").getBoundingClientRect().height;
  // 容器或图表尚未完成布局(宽/高≈0)→ 稍后重试,别画进塌陷的画布
  if ((box.width < 40 || H < 40) && ladderRetry < 40) { ladderRetry++; setTimeout(renderLadder, 80); return; }
  const W = Math.max(box.width, 60);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W); svg.setAttribute("height", H);
  if (!rows.length) { svg.innerHTML = `<text x="8" y="20" fill="#8b96ad" font-size="11">No data (collect once)</text>`; return; }
  // 中间零轴发散:正(绿)向右、负(红)向左;OI/量 模式 call 向右、put 向左
  const cx = W / 2, half = cx - 3;
  const magOf = (r) => r.net ? Math.abs(r.a) : Math.max(r.a, r.b);
  const maxV = Math.max(...rows.map(magOf), 1);
  const parts = [`<line x1="${cx}" y1="0" x2="${cx}" y2="${H}" stroke="#2a3550" stroke-width="1"/>`];
  const rowH = Math.max(Math.min(H / rows.length * 0.7, 9), 2);
  let placed = 0;
  for (const r of rows) {
    const y = candles.priceToCoordinate(r.strike);
    if (y == null || y < 0 || y > H) continue;
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
    const y = candles.priceToCoordinate(r.strike);
    if (y == null || y < 8 || y > H - 4) return;
    const toRight = r.net ? r.a >= 0 : true;  // net 按方向;OI/量 标在右侧
    const w = (r.net ? Math.abs(r.a) : Math.max(r.a, r.b)) / maxV * half;
    let lx = toRight ? cx + w + 2 : cx - w - 2, anchor = toRight ? "start" : "end";
    if (lx > W - 2) { lx = W - 2; anchor = "end"; } else if (lx < 2) { lx = 2; anchor = "start"; }
    parts.push(`<text x="${lx.toFixed(1)}" y="${(y + 3).toFixed(1)}" fill="#8b96ad" font-size="10" text-anchor="${anchor}">${r.strike}</text>`);
  });
  // 现价与 flip 横线
  const mark = (price, color, label) => {
    if (price == null) return;
    const y = candles.priceToCoordinate(price);
    if (y == null || y < 0 || y > H) return;
    parts.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" stroke="${color}" stroke-dasharray="4 3" stroke-width="1"/>`);
    parts.push(`<text x="2" y="${(y - 3).toFixed(1)}" fill="${color}" font-size="10">${label}</text>`);
  };
  mark(spotOf(SYM), "#60a5fa", "Spot");
  if (ladderMode === "gex") mark(gexBucketData(SYM)?.flip, "#fbbf24", "flip");
  svg.innerHTML = parts.join("");
  // 首屏图表坐标系未就绪时 priceToCoordinate 全返回 null → 稍后重试(用 setTimeout,后台标签页 rAF 会被节流)
  if (placed === 0 && rows.length && ladderRetry < 40) { ladderRetry++; setTimeout(renderLadder, 80); }
  else if (placed > 0) ladderRetry = 0;
}

/* ---------- 迷你行情卡(切票器 + 分组开关 + 增删) ---------- */
const isDeep = (s) => CFG.deep.includes(s);

function renderMiniCards() {
  const syms = CFG.watchlist.length ? CFG.watchlist : Object.keys(RESEARCH?.tickers || {});
  const deepSyms = syms.filter(isDeep);
  if (!SYM || !syms.includes(SYM)) SYM = deepSyms[0] || syms[0] || null;
  const cards = syms.map((s) => {
    const snap = RESEARCH?.snapshots?.[s] || {};
    const price = snap.price ?? lastClose(s);
    const pct = snap.chg_pct;
    const deep = isDeep(s);
    return `<div class="quote-card mini-card ${s === SYM ? "active" : ""} ${deep ? "" : "wl-only"}" data-act="pick" data-sym="${esc(s)}">
      <div class="mc-main">
        <div class="sym">${esc(s)}</div>
        <div class="price">${price != null ? Number(price).toFixed(2) : "—"}</div>
        <div class="chg ${(pct ?? 0) >= 0 ? "up" : "down"}">${pct != null ? ((pct >= 0 ? "+" : "") + pct.toFixed(2) + "%") : ""}</div>
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
  const adder = `<div class="quote-card mini-card mc-add">
    <input id="mc-add-input" placeholder="+ ticker" maxlength="6" autocomplete="off">
  </div>`;
  $("mini-cards").innerHTML = syms.length ? cards + adder : adder;
  updateCfgStatus();
}

/* ---------- 指标栏 ---------- */
function renderStats() {
  if (SYM && CFG.watchlist.length && !isDeep(SYM)) {
    $("wb-stats").innerHTML = `<span class="muted">${esc(SYM)} is in the "Quotes only" group — no deep data. Click "D" on its card to add to Deep.</span>`;
    return;
  }
  const d = researchOf(SYM);
  const o = d.options || {};
  const g = gexBucketData(SYM) || {};
  const sv = (d.short_vol || [])[0];
  const chips = [];
  const add = (k, v, cls = "") => v != null && chips.push(`<span>${k} <b class="${cls}">${v}</b></span>`);
  add("Data", d.asof ? new Date(d.asof).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) : null);
  add("RSI(1m)", d.ind?.rsi_m);
  add("RSI(D)", d.ind?.rsi_d);
  add("VWAP", d.vwap);
  // GEX 相对日均成交额:1% 变动的对冲量 ≈ 一天成交量的百分之几(跨标的可比的强度)
  const adv = d.short?.avg_daily_volume;
  const gexPct = (g.net_gex != null && adv && g.spot) ? g.net_gex / (adv * g.spot) * 100 : null;
  const bLabel = GEX_BUCKET_LABEL[g.bucket] || "";
  const calTag = g.caliber === "flow"
    ? `·Flow${g.classified ? "/" + g.classified + " ctr" : ""}`
      + (g.coverage != null ? ` cov${Math.round(g.coverage * 100)}%` : "")
      + (g.ambiguity != null ? ` amb${Math.round(g.ambiguity * 100)}%` : "")
    : "";
  add(`Net GEX(${bLabel}${g.fallback ? "·nearest" : ""}${calTag})`, g.net_gex != null
    ? fmtMoney(g.net_gex) + "/1%" + (gexPct != null ? ` (${gexPct >= 0 ? "+" : ""}${gexPct.toFixed(1)}% ADV)` : "")
    : null, (g.net_gex ?? 0) >= 0 ? "up" : "down");
  if (g.flowMiss) add("", "Flow N/A (computed 2×/day, single-names only; ETFs excluded)", "muted");
  add("flip", g.flip);
  add("MaxPain", o.max_pain);
  add("ATM IV", o.atm_iv != null ? (o.atm_iv * 100).toFixed(1) + "%" : null);
  // PCR 绝对值意义有限 → 补自身历史百分位 + watchlist 内横向排名(低 PCR=偏 call)
  if (o.pcr_vol != null) {
    const allV = Object.values(RESEARCH?.tickers || {}).map((d) => d.options?.pcr_vol).filter((v) => v != null);
    const rank = allV.filter((x) => x < o.pcr_vol).length + 1;  // 升序,1=最偏 call
    const self = o.pcr_vol_pct != null ? `self ${o.pcr_vol_pct}%ile` : "self n/a";
    add("PCR Vol", `${o.pcr_vol} (${self} · WL ${rank}/${allV.length})`);
  }
  add("Net Prem", o.net_premium != null ? fmtMoney(o.net_premium) : null, (o.net_premium ?? 0) >= 0 ? "up" : "down");
  add("Short%", sv?.ratio != null ? (sv.ratio * 100).toFixed(1) + "%" : null);
  $("wb-stats").innerHTML = chips.join("");
}

/* ---------- 期权面板 ---------- */
function renderOptPanel() {
  const d = researchOf(SYM);
  const o = d.options;
  $("opt-src").textContent = RESEARCH?.options_source ? `(source ${RESEARCH.options_source === "massive" ? "Massive" : "Yahoo"} · ${o?.contracts ?? 0} contracts)` : "";
  if (!o) { $("opt-panel").innerHTML = `<div class="card empty">No options data — start a collection</div>`; return; }
  const premTotal = (o.call_premium + o.put_premium) || 1;
  const cw = (o.call_premium / premTotal * 100).toFixed(1);
  const expRows = (o.by_expiry || []).map((e) => `<tr>
    <td>${esc(e.exp)}</td>
    <td><span class="up">${fmtMoney(e.call_premium)}</span> / <span class="down">${fmtMoney(e.put_premium)}</span></td>
    <td>${fmtNum(e.call_vol)} / ${fmtNum(e.put_vol)}</td>
    <td>${fmtNum(e.call_oi)} / ${fmtNum(e.put_oi)}</td>
    <td>${e.atm_iv != null ? (e.atm_iv * 100).toFixed(1) + "%" : "—"}</td>
  </tr>`).join("");
  const hotRows = (o.top_strikes || []).map((t) => `<tr>
    <td>${esc(t.exp)}</td><td>${t.strike}</td>
    <td class="${t.side === "call" ? "up" : "down"}">${t.side === "call" ? "Call" : "Put"}</td>
    <td>${fmtNum(t.vol)}</td><td>${fmtNum(t.oi)}</td><td>${fmtMoney(t.premium)}</td>
  </tr>`).join("");
  const oiRows = (o.oi_changes || []).map((c) => `<tr>
    <td>${esc(c.exp)}</td><td>${c.strike}</td>
    <td class="${c.side === "call" ? "up" : "down"}">${c.side === "call" ? "Call" : "Put"}</td>
    <td class="${c.delta >= 0 ? "up" : "down"}">${c.delta >= 0 ? "+" : ""}${fmtNum(c.delta)}</td>
  </tr>`).join("");
  const npCls = (o.net_premium ?? 0) >= 0 ? "up" : "down";
  const pd = o.prem_delta;
  const deltaHtml = pd ? (() => {
    const dc = (pd.call >= 0 ? "+" : "") + fmtMoney(pd.call);
    const dp = (pd.put >= 0 ? "+" : "") + fmtMoney(pd.put);
    const t = pd.since ? new Date(pd.since).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
    return `<span title="Increment of session-cumulative premium since ${esc(t)}">Δ vs last C <b class="${pd.call >= 0 ? "up" : "down"}">${dc}</b> / P <b class="${pd.put >= 0 ? "up" : "down"}">${dp}</b></span>`;
  })() : "";
  $("opt-panel").innerHTML = `<div class="card">
    <div class="prem-bar"><div class="prem-call" style="width:${cw}%"></div></div>
    <div class="stat-row">
      <span>Premium C <b class="up">${fmtMoney(o.call_premium)}</b> / P <b class="down">${fmtMoney(o.put_premium)}</b></span>
      <span>Vol C <b>${fmtNum(o.call_vol)}</b> / P <b>${fmtNum(o.put_vol)}</b>${o.pcr_vol != null ? ` <span class="muted">PCR ${o.pcr_vol}</span>` : ""}</span>
      <span>OI C <b>${fmtNum(o.call_oi)}</b> / P <b>${fmtNum(o.put_oi)}</b>${o.pcr_oi != null ? ` <span class="muted">PCR ${o.pcr_oi}</span>` : ""}</span>
    </div>
    <div class="stat-row">
      <span title="Call premium − Put premium; an activity metric (does not distinguish buy/sell side)">Net Prem <b class="${npCls}">${fmtMoney(o.net_premium)}</b></span>
      ${o.pcr_prem != null ? `<span title="Put premium / Call premium">PCR(prem) <b>${o.pcr_prem}</b></span>` : ""}
      ${deltaHtml}
    </div>
    <div class="muted small">Premium is total traded value, not split by aggressor buy/sell; the above are activity metrics — judge direction alongside price and OI change.</div>
    ${expRows ? `<details open><summary class="muted small">By expiry</summary>
      <table><tr><th>Expiry</th><th>Prem C/P</th><th>Vol C/P</th><th>OI C/P</th><th>ATM IV</th></tr>${expRows}</table></details>` : ""}
    ${hotRows ? `<details><summary class="muted small">Most active strikes today</summary>
      <table><tr><th>Expiry</th><th>Strike</th><th>Side</th><th>Vol</th><th>OI</th><th>Premium</th></tr>${hotRows}</table></details>` : ""}
    ${oiRows ? `<details><summary class="muted small">OI change (vs last collection)</summary>
      <table><tr><th>Expiry</th><th>Strike</th><th>Side</th><th>ΔOI</th></tr>${oiRows}</table></details>`
      : `<div class="muted small">OI change shows after two collections</div>`}
  </div>`;
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
  const cfg = await loadJSON("config/tickers.json") || {};
  CFG.watchlist = [...(cfg.watchlist || [])];
  CFG.deep = (cfg.deep || cfg.watchlist || []).filter((t) => CFG.watchlist.includes(t));
}

function scheduleSave() {
  cfgStatus = "Pending save…"; updateCfgStatus();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCfg, 1500);  // 防抖:连续切换合并成一次提交
}

async function saveCfg() {
  const pat = getPat() || $("gex-pat").value.trim();
  const watchlist = [...new Set(CFG.watchlist)];
  const deep = [...new Set(CFG.deep)].filter((t) => watchlist.includes(t));
  if (!pat) { cfgStatus = "⚠️ Group change not saved — enter PAT in Collection (needs Contents read/write)"; updateCfgStatus(); return; }
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
    cfgStatus = `✅ Saved (watchlist ${watchlist.length} · deep ${deep.length})`;
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
async function loadData() {
  [RESEARCH, GEX, GEXH] = await Promise.all([
    loadFreshJSON("data/research.json"),
    loadFreshJSON("data/gex.json"),
    loadFreshJSON("data/gex_history.json"),
  ]);
}

function renderAll(keepRange = false) {
  const lr = keepRange ? chart.timeScale().getVisibleLogicalRange() : null;
  renderMiniCards();
  renderStats();
  renderChart();
  renderGexSub();
  renderOptPanel();
  renderErrors();
  if (lr) chart.timeScale().setVisibleLogicalRange(lr);
  const upd = RESEARCH?.updated_at || GEX?.updated_at;
  $("poll-status").textContent = (upd ? `Data ${fmtDT(upd)}` : "No data")
    + ` · auto-refresh (${marketWindow() ? (getPat() ? "20s" : "2m, add PAT to speed up") : "off-hours 15m"})`;
}

async function refreshData() {
  await loadData();
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
      SYM = sym; localStorage.setItem("wbSym", SYM); renderAll();
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
  // 末尾添加框:回车加入 watchlist(默认仅行情,想深度再点「深」)
  $("mini-cards").addEventListener("keydown", (ev) => {
    if (ev.target.id !== "mc-add-input" || ev.key !== "Enter") return;
    const t = ev.target.value.trim().toUpperCase();
    if (t && !CFG.watchlist.includes(t)) { CFG.watchlist.push(t); scheduleSave(); renderMiniCards(); }
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
  $("refresh-btn").addEventListener("click", refreshData);
  [...$("gex-exp").children].forEach((b) => b.classList.toggle("active", b.dataset.b === gexBucket));
  [...$("gex-caliber").children].forEach((b) => b.classList.toggle("active", b.dataset.c === gexCaliber));
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
