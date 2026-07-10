/* 短线研究台 — 纯前端渲染,从 data/*.json 读取抓取结果 */

const $ = (id) => document.getElementById(id);
const esc = (t) => { const d = document.createElement("div"); d.textContent = t ?? ""; return d.innerHTML; };
const fmtDT = (iso) => iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—";
const CAT_LABEL = { news: "新闻", kol: "大V", youtube: "视频", community: "社区" };
const SOCIAL_CATS = ["community", "kol", "youtube"];

const REPO = "takkujunjieli/stock-dashboard";

let MARKET = null;   // Finnhub: 行情/财报/评级/公司新闻
let FEEDS = null;    // RSS: 新闻/社区/大V
let GEX = null;      // GEX 快照
let GEXH = null;     // GEX 盘中序列
let RESEARCH = null; // Massive/雅虎: K线/short/期权链指标
let socialCat = "all";
// 全局股票筛选(多选),空集 = 全部;记住上次的选择
let selected = new Set(JSON.parse(localStorage.getItem("tickerFilter") || "[]"));
const isSel = (sym) => selected.size === 0 || selected.has(sym);

function timeAgo(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
}

const fmtMoney = (v) => {
  if (v == null) return "—";
  const abs = Math.abs(v);
  const s = abs >= 1e9 ? (abs / 1e9).toFixed(2) + "B" : abs >= 1e6 ? (abs / 1e6).toFixed(1) + "M" : (abs / 1e3).toFixed(0) + "K";
  return (v < 0 ? "-$" : "$") + s;
};
const fmtNum = (v) => v == null ? "—" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : String(v);

async function loadJSON(path) {
  try {
    const r = await fetch(path + "?t=" + Date.now());
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch { return null; }
}

/* 盘中数据走 GitHub contents API 拿最新提交(采集期间 Pages 不重新部署),失败退回 Pages 相对路径 */
async function loadFreshJSON(path) {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?t=${Date.now()}`,
      { headers: { Accept: "application/vnd.github.raw+json" } });
    if (r.ok) return await r.json();
  } catch { /* 限流或离线时退回 Pages */ }
  return loadJSON(path);
}

/* ---------- 单票筛选(多选) ---------- */
function renderTickerFilter() {
  const syms = MARKET?.watchlist || [];
  $("ticker-filter").innerHTML = [
    `<button data-sym="__all" class="${selected.size === 0 ? "active" : ""}">全部</button>`,
    ...syms.map((s) => `<button data-sym="${esc(s)}" class="${selected.has(s) ? "active" : ""}">${esc(s)}</button>`),
  ].join("");
}

function initTickerFilter() {
  $("ticker-filter").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    if (btn.dataset.sym === "__all") selected.clear();
    else if (selected.has(btn.dataset.sym)) selected.delete(btn.dataset.sym);
    else selected.add(btn.dataset.sym);
    localStorage.setItem("tickerFilter", JSON.stringify([...selected]));
    renderAll();
  });
}

/* 信息流条目按选中股票匹配:标题/摘要里出现 $TSLA 或独立的 TSLA(区分大小写);
   单字母代码(如 U)只认 $U,避免误匹配普通单词 */
function feedMatches(i) {
  if (selected.size === 0) return true;
  const text = `${i.title || ""} ${i.summary || ""}`;
  return [...selected].some((sym) => {
    const re = sym.length >= 2 ? new RegExp(`\\b\\$?${sym}\\b`) : new RegExp(`\\$${sym}\\b`);
    return re.test(text);
  });
}

/* ---------- 行情条(优先 Massive 实时快照,回退 Finnhub) ---------- */
function renderQuotes(m) {
  const el = $("quotes-strip");
  const snaps = RESEARCH?.snapshots || {};
  const syms = (m?.watchlist || Object.keys(m?.quotes || {})).filter(isSel);
  el.innerHTML = syms.map((s) => {
    const snap = snaps[s];
    const q = snap?.price != null
      ? { c: snap.price, d: snap.chg, dp: snap.chg_pct }
      : (m?.quotes || {})[s];
    if (!q || q.c == null) return "";
    const cls = (q.d ?? 0) >= 0 ? "up" : "down";
    const sign = (q.d ?? 0) >= 0 ? "+" : "";
    return `<div class="quote-card">
      <div class="sym">${esc(s)}</div>
      <div class="price">${q.c.toFixed(2)}</div>
      <div class="chg ${cls}">${sign}${q.d?.toFixed(2) ?? "—"} (${sign}${q.dp?.toFixed(2) ?? "—"}%)</div>
    </div>`;
  }).join("") || `<div class="empty">暂无行情数据(检查 FINNHUB_API_KEY)</div>`;
}

/* ---------- 主页: 最近财报 EPS ---------- */
function renderSurprises(m) {
  const data = m.earnings_surprises || {};
  const cards = Object.entries(data)
    .filter(([sym, v]) => isSel(sym) && Array.isArray(v) && v.length)
    .map(([sym, list]) => {
      const rows = list.slice(0, 4).map((r) => {
        const pct = r.surprisePercent;
        const cls = pct == null ? "" : pct >= 0 ? "up" : "down";
        return `<tr>
          <td>${esc(r.period ?? "")}</td>
          <td>${r.actual?.toFixed(2) ?? "—"}</td>
          <td>${r.estimate?.toFixed(2) ?? "—"}</td>
          <td class="${cls}">${pct == null ? "—" : (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%"}</td>
        </tr>`;
      }).join("");
      return `<div class="card"><b>${esc(sym)}</b>
        <table><tr><th>季度</th><th>实际</th><th>预期</th><th>Surprise</th></tr>${rows}</table>
      </div>`;
    });
  $("earnings-surprises").innerHTML = cards.join("") || `<div class="card empty">暂无数据</div>`;
}

/* ---------- 主页: 分析师评级 ---------- */
function renderRecommendations(m) {
  const data = m.recommendations || {};
  const rows = Object.entries(data)
    .filter(([sym, v]) => isSel(sym) && Array.isArray(v) && v.length)
    .map(([sym, list]) => {
      const r = list[0]; // 最新一期
      const total = (r.strongBuy + r.buy + r.hold + r.sell + r.strongSell) || 1;
      const seg = (n, cls) => n ? `<div class="${cls}" style="width:${(n / total * 100).toFixed(1)}%"></div>` : "";
      return `<div class="rec-row">
        <div class="rec-sym">${esc(sym)}</div>
        <div class="rec-bar">
          ${seg(r.strongBuy, "rb-sbuy")}${seg(r.buy, "rb-buy")}${seg(r.hold, "rb-hold")}${seg(r.sell, "rb-sell")}${seg(r.strongSell, "rb-ssell")}
        </div>
        <div class="rec-nums">强买 ${r.strongBuy} · 买 ${r.buy} · 持有 ${r.hold} · 卖 ${r.sell} · 强卖 ${r.strongSell}</div>
      </div>`;
    });
  $("recommendations").innerHTML = rows.join("") || `<div class="empty">暂无数据</div>`;
}

/* ---------- 个股页: 分钟K线 ---------- */
let barGran = localStorage.getItem("barGran") || "5m";

function candleChart(bars, showDays = 2) {
  // 取最近 N 个交易日(按美东日期分组)
  const dayOf = (t) => new Date(t).toLocaleDateString("en-US", { timeZone: "America/New_York" });
  const days = [...new Set(bars.map((b) => dayOf(b[0])))].slice(-showDays);
  const rows = bars.filter((b) => days.includes(dayOf(b[0])));
  if (!rows.length) return "";
  const W = 640, H = 240, volH = 40, pad = 6, axisY = 14;
  const priceH = H - volH - axisY;
  const n = rows.length, bw = (W - pad * 2) / n;
  const hi = Math.max(...rows.map((r) => r[2]));
  const lo = Math.min(...rows.map((r) => r[3]));
  const maxV = Math.max(...rows.map((r) => r[5]), 1);
  const y = (v) => pad + (hi - v) / ((hi - lo) || 1) * (priceH - pad * 2);
  const parts = [];
  let lastDay = null;
  rows.forEach((r, i) => {
    const [t, o, h, l, c, v] = r;
    const x = pad + i * bw, xm = x + bw / 2;
    const up = c >= o;
    const color = up ? "#34d399" : "#f87171";
    // 换日分隔线
    const d = dayOf(t);
    if (lastDay && d !== lastDay) {
      parts.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${H - axisY}" stroke="#2a3550" stroke-dasharray="3 4"/>`);
      parts.push(`<text x="${(x + 3).toFixed(1)}" y="${H - 3}" fill="#8b96ad" font-size="9">${d}</text>`);
    }
    lastDay = d;
    parts.push(`<line x1="${xm.toFixed(1)}" y1="${y(h).toFixed(1)}" x2="${xm.toFixed(1)}" y2="${y(l).toFixed(1)}" stroke="${color}" stroke-width="0.8"/>`);
    const bh = Math.max(Math.abs(y(o) - y(c)), 0.8);
    parts.push(`<rect x="${(x + 0.5).toFixed(1)}" y="${Math.min(y(o), y(c)).toFixed(1)}" width="${Math.max(bw - 1, 0.8).toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}"><title>${new Date(t).toLocaleString("zh-CN", { hour12: false })}\nO ${o} H ${h} L ${l} C ${c}\nV ${fmtNum(v)}</title></rect>`);
    const vh = v / maxV * (volH - 4);
    parts.push(`<rect x="${(x + 0.5).toFixed(1)}" y="${(H - axisY - vh).toFixed(1)}" width="${Math.max(bw - 1, 0.8).toFixed(1)}" height="${vh.toFixed(1)}" fill="${color}" opacity="0.45"/>`);
  });
  const last = rows[rows.length - 1][4];
  return `<svg viewBox="0 0 ${W} ${H}" class="gex-chart" xmlns="http://www.w3.org/2000/svg">
    ${parts.join("")}
    <line x1="${pad}" y1="${y(last).toFixed(1)}" x2="${W - pad}" y2="${y(last).toFixed(1)}" stroke="#60a5fa" stroke-width="0.7" stroke-dasharray="2 3"/>
    <text x="${W - pad}" y="${(y(last) - 3).toFixed(1)}" fill="#60a5fa" font-size="10" text-anchor="end">${last}</text>
    <text x="${pad}" y="${(pad + 8)}" fill="#8b96ad" font-size="10">${hi.toFixed(2)}</text>
    <text x="${pad}" y="${(priceH - 2)}" fill="#8b96ad" font-size="10">${lo.toFixed(2)}</text>
  </svg>`;
}

function initBarGran() {
  const box = $("bar-gran");
  [...box.children].forEach((b) => b.classList.toggle("active", b.dataset.g === barGran));
  box.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    barGran = btn.dataset.g;
    localStorage.setItem("barGran", barGran);
    [...box.children].forEach((b) => b.classList.toggle("active", b === btn));
    renderStock();
  });
}

function renderStock() {
  const el = $("stock-cards");
  const entries = Object.entries(RESEARCH?.tickers || {}).filter(([s]) => isSel(s));
  if (!entries.length) {
    el.innerHTML = `<div class="card empty">${(RESEARCH?.errors || [])[0] ? esc(RESEARCH.errors[0]) : "暂无研究数据 — 在期权页启动一次采集,或等每日更新"}</div>`;
    return;
  }
  el.innerHTML = entries.map(([sym, d]) => {
    const bars = barGran === "1m" ? d.bars_1m : d.bars_5m;
    const src = barGran === "1m" ? d.src_1m : d.src_5m;
    const ind = d.ind || {};
    const emaTrend = ind.ema9_m != null && ind.ema21_m != null
      ? (ind.ema9_m >= ind.ema21_m
        ? `<span class="up">EMA9/21 ↑ 多头</span>` : `<span class="down">EMA9/21 ↓ 空头</span>`)
      : "";
    const indHtml = (ind.rsi_d != null || ind.rsi_m != null || d.vwap != null) ? `
      <div class="stat-row">
        ${ind.rsi_m != null ? `<span>RSI(1m) <b>${ind.rsi_m}</b></span>` : ""}
        ${ind.rsi_d != null ? `<span>RSI(日) <b>${ind.rsi_d}</b></span>` : ""}
        ${d.vwap != null ? `<span>VWAP <b>${d.vwap}</b></span>` : ""}
        ${emaTrend}
      </div>` : "";
    const sh = d.short;
    const sv = (d.short_vol || [])[0];
    const svTrend = (d.short_vol || []).slice(0, 5).reverse()
      .map((r) => r.ratio != null ? (r.ratio * 100).toFixed(0) : "—").join("/");
    const shortHtml = (sh || sv) ? `
      <div class="stat-row">
        ${sh ? `<span>Short Interest <b>${fmtNum(sh.short_interest)}</b></span>
        <span>DTC <b>${sh.days_to_cover ?? "—"}</b></span>
        <span class="muted">结算 ${esc(sh.settlement_date || "—")}</span>` : ""}
        ${sv?.ratio != null ? `<span>空头成交占比 <b>${(sv.ratio * 100).toFixed(1)}%</b> <span class="muted">(${esc(sv.date || "")},近5日 ${svTrend}%)</span></span>` : ""}
      </div>` : `<div class="muted small">做空数据暂无(需要 MASSIVE_API_KEY)</div>`;
    return `<div class="card stock-card">
      <div class="gex-head"><b>${esc(sym)}</b>${bars?.length ? `<span class="muted">${bars.length} 根 · 源 ${src === "massive" ? "Massive 实时" : "雅虎"}</span>` : ""}</div>
      ${indHtml}
      ${bars?.length ? candleChart(bars, barGran === "1m" ? 1 : 2) : `<div class="empty">暂无K线数据</div>`}
      ${shortHtml}
    </div>`;
  }).join("");
}

/* ---------- 期权页: 链上指标 ---------- */
function renderOptions() {
  const el = $("opt-cards");
  const entries = Object.entries(RESEARCH?.tickers || {})
    .filter(([s, d]) => isSel(s) && d.options);
  if (!entries.length) {
    el.innerHTML = `<div class="card empty">暂无期权链数据 — 启动一次采集,或等每日更新</div>`;
    return;
  }
  const src = RESEARCH?.options_source === "massive" ? "Massive" : "雅虎(回退)";
  el.innerHTML = entries.map(([sym, d]) => {
    const o = d.options;
    const premTotal = (o.call_premium + o.put_premium) || 1;
    const cw = (o.call_premium / premTotal * 100).toFixed(1);
    const oiRows = (o.oi_changes || []).map((c) => `<tr>
      <td>${esc(c.exp)}</td><td>${c.strike}</td>
      <td class="${c.side === "call" ? "up" : "down"}">${c.side === "call" ? "Call" : "Put"}</td>
      <td class="${c.delta >= 0 ? "up" : "down"}">${c.delta >= 0 ? "+" : ""}${fmtNum(c.delta)}</td>
    </tr>`).join("");
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
    return `<div class="card">
      <div class="gex-head"><b>${esc(sym)}</b><span class="muted">${o.contracts} 合约 · 源 ${src}</span>
        ${o.atm_iv ? `<span>ATM IV <b>${(o.atm_iv * 100).toFixed(1)}%</b></span>` : ""}
        ${o.max_pain != null ? `<span class="flip">Max Pain ${o.max_pain}<span class="muted">(${esc(o.max_pain_exp || "")})</span></span>` : ""}</div>
      <div class="prem-bar"><div class="prem-call" style="width:${cw}%"></div></div>
      <div class="stat-row">
        <span>Premium C <b class="up">${fmtMoney(o.call_premium)}</b></span>
        <span>P <b class="down">${fmtMoney(o.put_premium)}</b></span>
      </div>
      <div class="stat-row">
        <span>成交量 C <b>${fmtNum(o.call_vol)}</b> / P <b>${fmtNum(o.put_vol)}</b>${o.pcr_vol != null ? ` <span class="muted">PCR ${o.pcr_vol}</span>` : ""}</span>
        <span>OI C <b>${fmtNum(o.call_oi)}</b> / P <b>${fmtNum(o.put_oi)}</b>${o.pcr_oi != null ? ` <span class="muted">PCR ${o.pcr_oi}</span>` : ""}</span>
      </div>
      ${expRows ? `<details open><summary class="muted small">按到期日分解</summary>
        <table><tr><th>到期</th><th>Prem C/P</th><th>量 C/P</th><th>OI C/P</th><th>ATM IV</th></tr>${expRows}</table></details>` : ""}
      ${hotRows ? `<details><summary class="muted small">当日最活跃行权价 Top ${o.top_strikes.length}</summary>
        <table><tr><th>到期</th><th>行权价</th><th>方向</th><th>成交量</th><th>OI</th><th>Premium</th></tr>${hotRows}</table></details>` : ""}
      ${oiRows ? `<details><summary class="muted small">OI 变化 Top ${o.oi_changes.length}(vs 上次采集)</summary>
        <table><tr><th>到期</th><th>行权价</th><th>方向</th><th>ΔOI</th></tr>${oiRows}</table></details>`
        : `<div class="muted small">OI 变化需要两次采集后显示</div>`}
    </div>`;
  }).join("");
}

/* ---------- 新闻页: 财报日历 ---------- */
function renderCalendar(m) {
  const rows = (m.earnings_calendar || []).filter((e) => isSel(e.symbol));
  const hourLabel = { bmo: "盘前", amc: "盘后", dmh: "盘中" };
  const today = new Date().toISOString().slice(0, 10);
  const fmtRev = (v) => v == null ? "—" : (v / 1e9).toFixed(2) + "B";
  const fmtEps = (v) => v == null ? "—" : Number(v).toFixed(2);
  $("earnings-calendar").innerHTML = rows.length ? `<table>
    <tr><th>日期</th><th>代码</th><th>时段</th><th>EPS 预期</th><th>EPS 实际</th><th>营收预期</th><th>营收实际</th></tr>
    ${rows.map((e) => `<tr class="${e.date === today ? "today-row" : ""}">
      <td>${esc(e.date)}${e.date === today ? " ⭐" : ""}</td>
      <td><b>${esc(e.symbol)}</b></td>
      <td>${hourLabel[e.hour] || "—"}</td>
      <td>${fmtEps(e.epsEstimate)}</td>
      <td>${e.epsActual != null ? `<span class="${e.epsActual >= (e.epsEstimate ?? -1e9) ? "up" : "down"}">${fmtEps(e.epsActual)}</span>` : "—"}</td>
      <td>${fmtRev(e.revenueEstimate)}</td>
      <td>${fmtRev(e.revenueActual)}</td>
    </tr>`).join("")}
  </table>` : `<div class="empty">窗口期内没有财报安排</div>`;
}

/* ---------- 信息流条目渲染(新闻页和社区页共用) ---------- */
const feedItem = (i) => `<div class="item">
  <div class="meta"><span class="tag ${esc(i.category)}">${CAT_LABEL[i.category] || esc(i.category)}</span>${esc(i.source)} · ${timeAgo(i.published)}${i.heat != null ? ` · <span class="heat">▲ ${i.score} · 💬 ${i.comments}</span>` : ""}</div>
  <div class="title"><a href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.title)}</a></div>
  ${i.summary ? `<div class="summary">${esc(i.summary)}</div>` : ""}
</div>`;

/* ---------- 新闻页: 宏观/市场 RSS ---------- */
function renderNewsFeeds() {
  const items = (FEEDS?.items || []).filter((i) => i.category === "news" && feedMatches(i)).slice(0, 60);
  $("news-feeds").innerHTML = items.map(feedItem).join("")
    || `<div class="empty">${selected.size ? "选中的股票没有匹配的新闻(按标题/摘要里的代码匹配)" : "暂无内容"}</div>`;
}

/* ---------- 公司新闻(Finnhub) ---------- */
function renderCompanyNews(m) {
  const all = [];
  for (const [sym, list] of Object.entries(m.company_news || {})) {
    if (!isSel(sym)) continue;
    for (const n of list || []) all.push({ ...n, sym });
  }
  all.sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
  $("company-news").innerHTML = all.slice(0, 50).map((n) => `<div class="item">
    <div class="meta"><span class="tag">${esc(n.sym)}</span>${esc(n.source || "")} · ${timeAgo(new Date((n.datetime || 0) * 1000).toISOString())}</div>
    <div class="title"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.headline)}</a></div>
    ${n.summary ? `<div class="summary">${esc(n.summary.slice(0, 200))}</div>` : ""}
  </div>`).join("") || `<div class="empty">暂无数据</div>`;
}

/* ---------- 社区页: Reddit / X / 视频 ---------- */
function renderSocialFilters() {
  const present = new Set((FEEDS?.items || []).map((i) => i.category));
  const cats = ["all", ...SOCIAL_CATS.filter((c) => present.has(c))];
  $("social-filters").innerHTML = cats.map((c) =>
    `<button data-cat="${esc(c)}" class="${c === socialCat ? "active" : ""}">${c === "all" ? "全部" : (CAT_LABEL[c] || esc(c))}</button>`
  ).join("");
}

function initSocialFilters() {
  $("social-filters").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    socialCat = btn.dataset.cat;
    [...$("social-filters").children].forEach((b) => b.classList.toggle("active", b.dataset.cat === socialCat));
    renderSocial();
  });
}

function renderSocial() {
  const items = (FEEDS?.items || []).filter((i) =>
    SOCIAL_CATS.includes(i.category)
    && (socialCat === "all" || i.category === socialCat)
    && feedMatches(i));
  // 社区帖按热度(点赞 + 2×评论)排序;无数值时按 Reddit hot 榜排名;都没有则时间序
  const shown = [...items].sort((a, b) =>
    (b.heat || 0) - (a.heat || 0)
    || (a.rank ?? 999) - (b.rank ?? 999)
    || (b.published || "").localeCompare(a.published || "")).slice(0, 120);
  $("social-feeds").innerHTML = shown.map(feedItem).join("")
    || `<div class="empty">${selected.size ? "选中的股票没有匹配的内容(按标题/摘要里的代码匹配)" : "暂无内容"}</div>`;
}

/* ---------- 期权页: GEX ---------- */
const fmtGex = (v) => {
  const abs = Math.abs(v);
  const s = abs >= 1e9 ? (v / 1e9).toFixed(2) + "B" : (v / 1e6).toFixed(0) + "M";
  return (v >= 0 ? "+$" : "-$") + s.replace("-", "");
};

function gexBarChart(rows, spot, flip) {
  if (!rows?.length) return "";
  const W = 640, H = 200, pad = 10, axisY = 16;
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.net)), 1);
  const bw = (W - pad * 2) / rows.length;
  const mid = (H - axisY) / 2;
  const bars = rows.map((r, i) => {
    const h = Math.max(Math.abs(r.net) / maxAbs * (mid - 6), 0.5);
    const y = r.net >= 0 ? mid - h : mid;
    return `<rect x="${(pad + i * bw + 0.5).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(bw - 1, 0.8).toFixed(1)}" height="${h.toFixed(1)}" fill="${r.net >= 0 ? "#34d399" : "#f87171"}"><title>${r.strike}: ${fmtGex(r.net)}</title></rect>`;
  }).join("");
  const xAt = (v) => { // 行权价不等距,取最近柱子的中心
    let best = 0;
    rows.forEach((r, i) => { if (Math.abs(r.strike - v) < Math.abs(rows[best].strike - v)) best = i; });
    return pad + best * bw + bw / 2;
  };
  const vline = (v, color, label) => v == null ? "" :
    `<line x1="${xAt(v)}" y1="0" x2="${xAt(v)}" y2="${H - axisY}" stroke="${color}" stroke-dasharray="4 3" stroke-width="1.2"/>
     <text x="${xAt(v)}" y="${H - 4}" fill="${color}" font-size="10" text-anchor="middle">${label} ${v}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="gex-chart" xmlns="http://www.w3.org/2000/svg">
    <line x1="${pad}" y1="${mid}" x2="${W - pad}" y2="${mid}" stroke="#2a3550"/>
    <text x="${pad}" y="${H - 4}" fill="#8b96ad" font-size="10">${rows[0].strike}</text>
    <text x="${W - pad}" y="${H - 4}" fill="#8b96ad" font-size="10" text-anchor="end">${rows[rows.length - 1].strike}</text>
    ${bars}
    ${vline(spot, "#60a5fa", "现价")}
    ${vline(flip, "#fbbf24", "flip")}
  </svg>`;
}

function gexSparkline(points) {
  if (!points || points.length < 2) {
    return `<div class="muted small">盘中净 GEX 走势会随采集累积(当前 ${points?.length || 0} 个点)</div>`;
  }
  const W = 640, H = 70, pad = 6;
  const ts = points.map((p) => new Date(p.t).getTime());
  const vs = points.map((p) => p.net);
  const [t0, t1] = [Math.min(...ts), Math.max(...ts)];
  const [v0, v1] = [Math.min(...vs, 0), Math.max(...vs, 0)];
  const x = (t) => pad + (t - t0) / Math.max(t1 - t0, 1) * (W - pad * 2);
  const y = (v) => H - pad - (v - v0) / Math.max(v1 - v0, 1) * (H - pad * 2);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(new Date(p.t).getTime()).toFixed(1)},${y(p.net).toFixed(1)}`).join("");
  const t2hm = (t) => new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `<svg viewBox="0 0 ${W} ${H}" class="gex-chart" xmlns="http://www.w3.org/2000/svg">
    <line x1="${pad}" y1="${y(0)}" x2="${W - pad}" y2="${y(0)}" stroke="#2a3550" stroke-dasharray="3 3"/>
    <path d="${line}" fill="none" stroke="#60a5fa" stroke-width="1.6"/>
    <text x="${pad}" y="${H - 1}" fill="#8b96ad" font-size="9">${t2hm(t0)}</text>
    <text x="${W - pad}" y="${H - 1}" fill="#8b96ad" font-size="9" text-anchor="end">${t2hm(t1)}</text>
  </svg>`;
}

function renderGex() {
  const el = $("gex-cards");
  const entries = Object.entries(GEX?.tickers || {}).filter(([s]) => isSel(s));
  if (!entries.length) {
    const hint = (GEX?.errors || []).length ? esc(GEX.errors[0]) : "还没有 GEX 数据,在上方启动一次采集";
    el.innerHTML = `<div class="card empty">${hint}</div>`;
    return;
  }
  el.innerHTML = entries.map(([sym, d]) => {
    const pts = (GEXH?.points || []).filter((p) => p.sym === sym);
    return `<div class="card gex-card">
      <div class="gex-head">
        <b>${esc(sym)}</b>
        <span class="muted">现价 ${d.spot}</span>
        <span class="${d.net_gex >= 0 ? "up" : "down"}">净GEX ${fmtGex(d.net_gex)}/1%</span>
        ${d.flip != null ? `<span class="flip">flip ≈ ${d.flip}</span>` : ""}
      </div>
      ${gexBarChart(d.by_strike, d.spot, d.flip)}
      ${gexSparkline(pts)}
    </div>`;
  }).join("");
}

/* ---------- 采集控制(GitHub Actions API) ---------- */
const ghHeaders = (pat) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${pat}`,
});

function setGexStatus(msg) { $("gex-status").innerHTML = msg; }

async function refreshGexStatus() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/gex.yml/runs?per_page=1&t=${Date.now()}`);
    if (!r.ok) throw new Error(r.status);
    const run = (await r.json()).workflow_runs?.[0];
    if (!run) { setGexStatus("采集状态: 还没有运行记录"); return; }
    const state = run.status === "completed"
      ? (run.conclusion === "success" ? "✅ 已完成" : run.conclusion === "cancelled" ? "⏹ 已停止" : "❌ " + run.conclusion)
      : "🟢 运行中";
    setGexStatus(`采集状态: ${state} · ${run.display_title || run.name} · 启动于 ${fmtDT(run.created_at)} · <a href="${run.html_url}" target="_blank" rel="noopener">查看日志</a>`);
  } catch { setGexStatus("采集状态: 查询失败(可能是 API 限流,稍后再试)"); }
}

function initGexControls() {
  $("gex-pat").value = localStorage.getItem("ghPat") || "";

  $("gex-start-btn").addEventListener("click", async () => {
    const pat = $("gex-pat").value.trim();
    if (!pat) { setGexStatus("⚠️ 需要 GitHub PAT(fine-grained,只授权本仓库 Actions 读写)"); return; }
    localStorage.setItem("ghPat", pat);
    const toIso = (v) => v ? new Date(v).toISOString().replace(/\.\d{3}Z$/, "Z") : "";
    const inputs = {
      start: toIso($("gex-start").value),
      end: toIso($("gex-end").value),
      gap: $("gex-gap").value,
    };
    if (inputs.end && inputs.start && inputs.end <= inputs.start) { setGexStatus("⚠️ 结束时间要晚于开始时间"); return; }
    setGexStatus("正在启动…");
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/gex.yml/dispatches`, {
        method: "POST", headers: ghHeaders(pat),
        body: JSON.stringify({ ref: "main", inputs }),
      });
      if (r.status !== 204) throw new Error(`HTTP ${r.status}: ${(await r.json())?.message || ""}`);
      setGexStatus("✅ 已启动,几秒后刷新状态…");
      setTimeout(refreshGexStatus, 5000);
    } catch (e) { setGexStatus(`❌ 启动失败: ${esc(e.message)}(检查 PAT 权限)`); }
  });

  $("gex-stop-btn").addEventListener("click", async () => {
    const pat = $("gex-pat").value.trim();
    if (!pat) { setGexStatus("⚠️ 停止需要 PAT"); return; }
    setGexStatus("正在停止…");
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/gex.yml/runs?status=in_progress&t=${Date.now()}`);
      const runs = (await r.json()).workflow_runs || [];
      if (!runs.length) { setGexStatus("当前没有运行中的采集"); return; }
      for (const run of runs) {
        await fetch(`https://api.github.com/repos/${REPO}/actions/runs/${run.id}/cancel`,
          { method: "POST", headers: ghHeaders(pat) });
      }
      setGexStatus(`✅ 已请求停止 ${runs.length} 个运行`);
      setTimeout(refreshGexStatus, 5000);
    } catch (e) { setGexStatus(`❌ 停止失败: ${esc(e.message)}`); }
  });

  $("gex-refresh-btn").addEventListener("click", async () => {
    setGexStatus("刷新数据中…");
    [GEX, GEXH, RESEARCH] = await Promise.all([
      loadFreshJSON("data/gex.json"),
      loadFreshJSON("data/gex_history.json"),
      loadFreshJSON("data/research.json"),
    ]);
    renderGex();
    renderOptions();
    renderStock();
    refreshGexStatus();
  });
}

/* ---------- 错误汇总 ---------- */
function renderErrors() {
  const msgs = [
    ...(MARKET?.errors || []),
    ...((FEEDS?.errors || []).map((e) => `${e.source}: ${e.error}`)),
    ...(GEX?.errors || []),
    ...(RESEARCH?.errors || []),
  ];
  $("errors").innerHTML = msgs.length
    ? `<details><summary>⚠️ ${msgs.length} 条数据源提示(点开查看)</summary><ul>${msgs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></details>`
    : "";
}

/* ---------- Tab 切换(支持 #stock / #options 等直达,兼容旧锚点) ---------- */
function initTabs() {
  const nav = $("nav");
  const names = ["home", "stock", "options", "news", "social"];
  const legacy = { overview: "home", feeds: "social", gex: "options" };
  const activate = (name) => {
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
    nav.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  };
  nav.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".tab");
    if (!btn) return;
    history.replaceState(null, "", "#" + btn.dataset.tab);
    activate(btn.dataset.tab);
    window.scrollTo(0, 0);
  });
  let initial = location.hash.slice(1);
  initial = legacy[initial] || initial;
  if (names.includes(initial)) activate(initial);
}

function renderAll() {
  renderTickerFilter();
  if (MARKET) {
    renderQuotes(MARKET);
    renderCalendar(MARKET);
    renderSurprises(MARKET);
    renderRecommendations(MARKET);
    renderCompanyNews(MARKET);
  }
  if (FEEDS) { renderNewsFeeds(); renderSocial(); }
  renderStock();
  renderOptions();
  renderGex();
  renderErrors();
}

/* ---------- 入口 ---------- */
(async function main() {
  initTabs();
  initTickerFilter();
  initSocialFilters();
  initGexControls();
  initBarGran();

  [MARKET, FEEDS, GEX, GEXH, RESEARCH] = await Promise.all([
    loadJSON("data/market.json"),
    loadJSON("data/feeds.json"),
    loadFreshJSON("data/gex.json"),
    loadFreshJSON("data/gex_history.json"),
    loadFreshJSON("data/research.json"),
  ]);
  refreshGexStatus();

  // watchlist 变动后清掉已失效的选择
  const watch = new Set(MARKET?.watchlist || []);
  selected = new Set([...selected].filter((s) => watch.has(s)));

  const times = [MARKET?.updated_at, FEEDS?.updated_at, RESEARCH?.updated_at].filter(Boolean);
  $("updated").textContent = times.length
    ? "最后更新: " + fmtDT(times.sort().at(-1))
    : "还没有数据 — 先运行一次抓取脚本或 GitHub Actions";

  renderSocialFilters();
  renderAll();
})();
