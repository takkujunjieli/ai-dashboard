/* 交易台 — 单票工作台:K线主图 + 共享价格轴行权价梯 + 期权面板 + 采集控制
   图表库: TradingView lightweight-charts v4(CDN,全局 LightweightCharts) */
import {
  $, esc, fmtDT, fmtMoney, fmtNum, REPO, loadFreshJSON, getPat, setPat, ghHeaders,
} from "./shared.js";

const LWC = window.LightweightCharts;
const ET = "America/New_York";

let RESEARCH = null, GEX = null, GEXH = null;
let SYM = localStorage.getItem("wbSym") || null;
let TF = localStorage.getItem("wbTf") || "5m";
let ladderMode = "gex";
let chart, candles, volume, ema9L, ema21L, vwapL, subChart, gexLine;
let priceLines = [];
let pollTimer = null;

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

const lastClose = (sym) => {
  const b = researchOf(sym).bars_1m || researchOf(sym).bars_5m || [];
  return b.length ? b[b.length - 1][4] : null;
};
const spotOf = (sym) => (RESEARCH?.snapshots?.[sym]?.price) ?? lastClose(sym) ?? GEX?.tickers?.[sym]?.spot;

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
  ema9L = chart.addLineSeries({ color: "#60a5fa", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  ema21L = chart.addLineSeries({ color: "#c084fc", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  vwapL = chart.addLineSeries({ color: "#fbbf24", lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false });

  subChart = LWC.createChart($("gex-sub"), { ...chartTheme, timeScale: { ...chartTheme.timeScale, timeVisible: true } });
  gexLine = subChart.addLineSeries({ color: "#60a5fa", lineWidth: 2, priceFormat: { type: "custom", formatter: (v) => (v / 1e6).toFixed(0) + "M" } });

  chart.timeScale().subscribeVisibleLogicalRangeChange(() => requestAnimationFrame(renderLadder));
  new ResizeObserver(() => requestAnimationFrame(renderLadder)).observe($("chart"));
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

  // 关键价位线: gamma flip / Max Pain
  priceLines.forEach((l) => candles.removePriceLine(l));
  priceLines = [];
  const flip = GEX?.tickers?.[SYM]?.flip;
  const mp = researchOf(SYM).options?.max_pain;
  if (flip != null) priceLines.push(candles.createPriceLine({ price: flip, color: "#fbbf24", lineStyle: LWC.LineStyle.Dashed, lineWidth: 1, title: "flip" }));
  if (mp != null) priceLines.push(candles.createPriceLine({ price: mp, color: "#c084fc", lineStyle: LWC.LineStyle.Dashed, lineWidth: 1, title: "MaxPain" }));

  const visible = TF === "1d" ? 130 : TF === "1m" ? 200 : 160;
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - visible), to: bars.length + 3 });
  requestAnimationFrame(renderLadder);
}

/* ---------- 盘中净 GEX 副图 ---------- */
function renderGexSub() {
  const pts = (GEXH?.points || []).filter((p) => p.sym === SYM);
  gexLine.setData(pts.map((p) => ({ time: tconv(Date.parse(p.t)), value: p.net })));
  subChart.timeScale().fitContent();
}

/* ---------- 行权价梯(与主图共享价格轴) ---------- */
function ladderRows() {
  if (ladderMode === "gex") {
    return (GEX?.tickers?.[SYM]?.by_strike || []).map((r) => ({ strike: r.strike, a: r.net, b: 0, net: true }));
  }
  const key = ladderMode === "oi" ? "oi" : "vol";
  return (researchOf(SYM).options?.by_strike || []).map((r) => ({
    strike: r.strike, a: r[`call_${key}`] || 0, b: r[`put_${key}`] || 0, net: false,
  }));
}

function renderLadder() {
  const svg = $("ladder");
  if (!svg || !candles) return;
  const rows = ladderRows();
  const box = $("ladder-box").getBoundingClientRect();
  const W = Math.max(box.width, 60), H = $("chart").getBoundingClientRect().height;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W); svg.setAttribute("height", H);
  if (!rows.length) { svg.innerHTML = `<text x="8" y="20" fill="#8b96ad" font-size="11">暂无数据(先采集一次)</text>`; return; }
  const maxV = Math.max(...rows.map((r) => Math.abs(r.a) + Math.abs(r.b)), 1);
  const parts = [];
  const rowH = Math.max(Math.min(H / rows.length * 0.7, 9), 2);
  for (const r of rows) {
    const y = candles.priceToCoordinate(r.strike);
    if (y == null || y < 0 || y > H) continue;
    if (r.net) {
      const w = Math.abs(r.a) / maxV * (W - 46);
      parts.push(`<rect x="0" y="${(y - rowH / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${rowH}" fill="${r.a >= 0 ? "#34d399" : "#f87171"}" opacity="0.85"><title>${r.strike}: ${fmtMoney(r.a)}</title></rect>`);
    } else {
      const wc = r.a / maxV * (W - 46), wp = r.b / maxV * (W - 46);
      parts.push(`<rect x="0" y="${(y - rowH / 2).toFixed(1)}" width="${wc.toFixed(1)}" height="${rowH}" fill="#34d399" opacity="0.85"><title>${r.strike} Call: ${fmtNum(r.a)}</title></rect>`);
      parts.push(`<rect x="${wc.toFixed(1)}" y="${(y - rowH / 2).toFixed(1)}" width="${wp.toFixed(1)}" height="${rowH}" fill="#f87171" opacity="0.85"><title>${r.strike} Put: ${fmtNum(r.b)}</title></rect>`);
    }
  }
  // 量级最大的 4 行标注行权价
  [...rows].sort((x, y2) => (Math.abs(y2.a) + Math.abs(y2.b)) - (Math.abs(x.a) + Math.abs(x.b))).slice(0, 4).forEach((r) => {
    const y = candles.priceToCoordinate(r.strike);
    if (y == null || y < 8 || y > H - 4) return;
    parts.push(`<text x="${W - 2}" y="${(y + 3).toFixed(1)}" fill="#8b96ad" font-size="10" text-anchor="end">${r.strike}</text>`);
  });
  // 现价与 flip 横线
  const mark = (price, color, label) => {
    if (price == null) return;
    const y = candles.priceToCoordinate(price);
    if (y == null || y < 0 || y > H) return;
    parts.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" stroke="${color}" stroke-dasharray="4 3" stroke-width="1"/>`);
    parts.push(`<text x="2" y="${(y - 3).toFixed(1)}" fill="${color}" font-size="10">${label}</text>`);
  };
  mark(spotOf(SYM), "#60a5fa", "现价");
  mark(GEX?.tickers?.[SYM]?.flip, "#fbbf24", "flip");
  svg.innerHTML = parts.join("");
}

/* ---------- 迷你行情卡(切票器) ---------- */
function renderMiniCards() {
  const syms = Object.keys(RESEARCH?.tickers || {});
  if (!SYM || !syms.includes(SYM)) SYM = syms[0] || null;
  $("mini-cards").innerHTML = syms.map((s) => {
    const snap = RESEARCH?.snapshots?.[s] || {};
    const price = snap.price ?? lastClose(s);
    const pct = snap.chg_pct;
    return `<div class="quote-card mini-card ${s === SYM ? "active" : ""}" data-sym="${esc(s)}">
      <div class="sym">${esc(s)}</div>
      <div class="price">${price != null ? Number(price).toFixed(2) : "—"}</div>
      <div class="chg ${(pct ?? 0) >= 0 ? "up" : "down"}">${pct != null ? ((pct >= 0 ? "+" : "") + pct.toFixed(2) + "%") : ""}</div>
    </div>`;
  }).join("") || `<div class="empty">暂无数据 — 先启动一次采集</div>`;
}

/* ---------- 指标栏 ---------- */
function renderStats() {
  const d = researchOf(SYM);
  const o = d.options || {};
  const g = GEX?.tickers?.[SYM] || {};
  const sv = (d.short_vol || [])[0];
  const chips = [];
  const add = (k, v, cls = "") => v != null && chips.push(`<span>${k} <b class="${cls}">${v}</b></span>`);
  add("数据", d.asof ? new Date(d.asof).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : null);
  add("RSI(1m)", d.ind?.rsi_m);
  add("RSI(日)", d.ind?.rsi_d);
  add("VWAP", d.vwap);
  // GEX 相对日均成交额:1% 变动的对冲量 ≈ 一天成交量的百分之几(跨标的可比的强度)
  const adv = d.short?.avg_daily_volume;
  const gexPct = (g.net_gex != null && adv && g.spot) ? g.net_gex / (adv * g.spot) * 100 : null;
  add("净GEX", g.net_gex != null
    ? fmtMoney(g.net_gex) + "/1%" + (gexPct != null ? ` (${gexPct >= 0 ? "+" : ""}${gexPct.toFixed(1)}% ADV)` : "")
    : null, g.net_gex >= 0 ? "up" : "down");
  add("flip", g.flip);
  add("MaxPain", o.max_pain);
  add("ATM IV", o.atm_iv != null ? (o.atm_iv * 100).toFixed(1) + "%" : null);
  add("PCR量", o.pcr_vol);
  add("Net Prem", o.net_premium != null ? fmtMoney(o.net_premium) : null, (o.net_premium ?? 0) >= 0 ? "up" : "down");
  add("空头占比", sv?.ratio != null ? (sv.ratio * 100).toFixed(1) + "%" : null);
  $("wb-stats").innerHTML = chips.join("");
}

/* ---------- 期权面板 ---------- */
function renderOptPanel() {
  const d = researchOf(SYM);
  const o = d.options;
  $("opt-src").textContent = RESEARCH?.options_source ? `(源 ${RESEARCH.options_source === "massive" ? "Massive" : "雅虎"} · ${o?.contracts ?? 0} 合约)` : "";
  if (!o) { $("opt-panel").innerHTML = `<div class="card empty">暂无期权数据 — 启动一次采集</div>`; return; }
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
    const t = pd.since ? new Date(pd.since).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "";
    return `<span title="自 ${esc(t)} 起本交易日累计成交额的增量">较上批 C <b class="${pd.call >= 0 ? "up" : "down"}">${dc}</b> / P <b class="${pd.put >= 0 ? "up" : "down"}">${dp}</b></span>`;
  })() : "";
  $("opt-panel").innerHTML = `<div class="card">
    <div class="prem-bar"><div class="prem-call" style="width:${cw}%"></div></div>
    <div class="stat-row">
      <span>Premium C <b class="up">${fmtMoney(o.call_premium)}</b> / P <b class="down">${fmtMoney(o.put_premium)}</b></span>
      <span>量 C <b>${fmtNum(o.call_vol)}</b> / P <b>${fmtNum(o.put_vol)}</b>${o.pcr_vol != null ? ` <span class="muted">PCR ${o.pcr_vol}</span>` : ""}</span>
      <span>OI C <b>${fmtNum(o.call_oi)}</b> / P <b>${fmtNum(o.put_oi)}</b>${o.pcr_oi != null ? ` <span class="muted">PCR ${o.pcr_oi}</span>` : ""}</span>
    </div>
    <div class="stat-row">
      <span title="Call 成交额 − Put 成交额,活跃度指标(不区分买卖方向)">Net Prem <b class="${npCls}">${fmtMoney(o.net_premium)}</b></span>
      ${o.pcr_prem != null ? `<span title="Put 成交额 / Call 成交额">PCR(额) <b>${o.pcr_prem}</b></span>` : ""}
      ${deltaHtml}
    </div>
    <div class="muted small">Premium 为成交总额,不区分主动买/卖;以上为活跃度指标,方向判断请结合价格与 OI 变化</div>
    ${expRows ? `<details open><summary class="muted small">按到期日分解</summary>
      <table><tr><th>到期</th><th>Prem C/P</th><th>量 C/P</th><th>OI C/P</th><th>ATM IV</th></tr>${expRows}</table></details>` : ""}
    ${hotRows ? `<details><summary class="muted small">当日最活跃行权价</summary>
      <table><tr><th>到期</th><th>行权价</th><th>方向</th><th>成交量</th><th>OI</th><th>Premium</th></tr>${hotRows}</table></details>` : ""}
    ${oiRows ? `<details><summary class="muted small">OI 变化(vs 上次采集)</summary>
      <table><tr><th>到期</th><th>行权价</th><th>方向</th><th>ΔOI</th></tr>${oiRows}</table></details>`
      : `<div class="muted small">OI 变化需要两次采集后显示</div>`}
  </div>`;
}

/* ---------- 错误 ---------- */
function renderErrors() {
  const msgs = [...(RESEARCH?.errors || []), ...(GEX?.errors || [])];
  $("errors").innerHTML = msgs.length
    ? `<details><summary>⚠️ ${msgs.length} 条数据源提示</summary><ul>${msgs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></details>` : "";
}

/* ---------- 采集控制(GitHub Actions API) ---------- */
function setGexStatus(msg) { $("gex-status").innerHTML = msg; }

async function refreshRunStatus() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/gex.yml/runs?per_page=1&t=${Date.now()}`);
    if (!r.ok) throw new Error(r.status);
    const run = (await r.json()).workflow_runs?.[0];
    if (!run) { setGexStatus("采集状态: 还没有运行记录"); return; }
    const state = run.status === "completed"
      ? (run.conclusion === "success" ? "✅ 已完成" : run.conclusion === "cancelled" ? "⏹ 已停止" : "❌ " + run.conclusion)
      : "🟢 运行中";
    setGexStatus(`采集状态: ${state} · 启动于 ${fmtDT(run.created_at)} · <a href="${run.html_url}" target="_blank" rel="noopener">日志</a>`);
  } catch { setGexStatus("采集状态: 查询失败(可能限流,稍后再试)"); }
}

async function dispatchSession(inputs, label) {
  const pat = $("gex-pat").value.trim();
  if (!pat) { setGexStatus("⚠️ 需要 GitHub PAT(fine-grained,只授权本仓库 Actions 读写)"); return; }
  setPat(pat); startPolling();
  setGexStatus(`正在启动${label}…`);
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/gex.yml/dispatches`, {
      method: "POST", headers: ghHeaders(pat), body: JSON.stringify({ ref: "main", inputs }),
    });
    if (r.status !== 204) throw new Error(`HTTP ${r.status}: ${(await r.json())?.message || ""}`);
    setGexStatus(`✅ ${label}已启动,几秒后刷新状态…`);
    setTimeout(refreshRunStatus, 5000);
  } catch (e) { setGexStatus(`❌ 启动失败: ${esc(e.message)}(检查 PAT 权限)`); }
}

function initControls() {
  $("gex-pat").value = getPat();
  // 粘贴/修改 PAT 即保存(仅本机 localStorage),自动轮询提速到 60 秒
  $("gex-pat").addEventListener("change", () => {
    setPat($("gex-pat").value.trim());
    startPolling();
    refreshData();
  });
  $("gex-start-btn").addEventListener("click", () => dispatchSession({}, "滚动会话"));
  $("gex-once-btn").addEventListener("click", () => dispatchSession({ once: "true" }, "单轮采集"));
  $("gex-stop-btn").addEventListener("click", async () => {
    const pat = $("gex-pat").value.trim();
    if (!pat) { setGexStatus("⚠️ 停止需要 PAT"); return; }
    setGexStatus("正在停止…");
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/gex.yml/runs?status=in_progress&t=${Date.now()}`);
      const runs = (await r.json()).workflow_runs || [];
      if (!runs.length) { setGexStatus("当前没有运行中的采集"); return; }
      for (const run of runs) {
        await fetch(`https://api.github.com/repos/${REPO}/actions/runs/${run.id}/cancel`, { method: "POST", headers: ghHeaders(pat) });
      }
      setGexStatus(`✅ 已请求停止 ${runs.length} 个运行`);
      setTimeout(refreshRunStatus, 5000);
    } catch (e) { setGexStatus(`❌ 停止失败: ${esc(e.message)}`); }
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
  $("poll-status").textContent = (upd ? `数据 ${fmtDT(upd)}` : "暂无数据")
    + ` · 自动刷新(${marketWindow() ? (getPat() ? "60秒" : "5分钟,填 PAT 提速") : "盘外30分钟"})`;
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
  const iv = marketWindow() ? (getPat() ? 60_000 : 300_000) : 1_800_000;
  pollTimer = setTimeout(refreshData, iv);
}

/* ---------- 交互绑定 ---------- */
function initToolbar() {
  $("mini-cards").addEventListener("click", (ev) => {
    const card = ev.target.closest(".mini-card");
    if (!card) return;
    SYM = card.dataset.sym;
    localStorage.setItem("wbSym", SYM);
    renderAll();
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
    $("ladder-title").textContent = "行权价梯 · " + { gex: "GEX", oi: "OI", vol: "成交量" }[ladderMode];
    renderLadder();
  });
  $("refresh-btn").addEventListener("click", refreshData);
}

/* ---------- 入口 ---------- */
(async function main() {
  initCharts();
  initToolbar();
  initControls();
  [...$("tf-chips").children].forEach((b) => b.classList.toggle("active", b.dataset.tf === TF));
  await loadData();
  renderAll();
  refreshRunStatus();
  startPolling();
})();
