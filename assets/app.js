/* 信息页 — 阅读型内容:主页(行情/EPS/评级)、新闻、社区 */
import {
  $, esc, fmtDT, fmtMoney, timeAgo, CAT_LABEL, SENTI, loadJSON, loadFreshJSON,
} from "./shared.js";

const SOCIAL_CATS = ["community", "kol", "youtube"];

let MARKET = null;   // Finnhub: 行情/财报/评级/公司新闻
let FEEDS = null;    // RSS: 新闻/社区/大V
let RESEARCH = null; // 只用它的 snapshots(实时行情)和 news(情绪新闻)
let HOLD13F = null;  // 精选机构 13F 持仓
let socialCat = "all";
// 全局股票筛选(多选),空集 = 全部;记住上次的选择。票的增减在交易台「标的配置」操作。
let selected = new Set(JSON.parse(localStorage.getItem("tickerFilter") || "[]"));
const isSel = (sym) => selected.size === 0 || selected.has(sym);

/* ---------- 单票筛选(多选) ---------- */
function renderTickerFilter() {
  const syms = MARKET?.watchlist || [];
  $("ticker-filter").innerHTML = [
    `<button data-sym="__all" class="${selected.size === 0 ? "active" : ""}">All</button>`,
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
  if (Array.isArray(i.tickers) && i.tickers.some((t) => selected.has(t))) return true;  // Massive 结构化票代码,最精确
  const text = `${i.title || ""} ${i.summary || ""}`;
  return [...selected].some((sym) => {
    const re = sym.length >= 2 ? new RegExp(`\\b\\$?${sym}\\b`) : new RegExp(`\\$${sym}\\b`);
    return re.test(text);
  });
}

/* ---------- 主页: 精选机构 13F 持仓 ---------- */
function qLabel(p) { const [y, m] = p.split("-"); return `Q${Math.ceil(+m / 3)}'${y.slice(2)}`; }
function fmtShares(n) {
  return n == null ? "—" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "K" : String(n);
}
function render13f() {
  const d = HOLD13F || {};
  const cards = Object.entries(d.tickers || {})
    .filter(([sym]) => isSel(sym))
    .map(([sym, v]) => {
      const periods = (v.periods || []).slice(0, 4);   // 最近在前
      const byFiler = {};                               // filer → {period: holding}
      for (const h of v.holdings || []) (byFiler[h.filer] ||= {})[h.period] = h;
      const head = `<tr><th>Fund</th>${periods.map((p) => `<th>${qLabel(p)}</th>`).join("")}</tr>`;
      const rows = Object.entries(byFiler).map(([f, ps]) => {
        const cells = periods.map((p, i) => {
          const h = ps[p];
          if (!h) return `<td class="muted">—</td>`;
          const prev = ps[periods[i + 1]];               // 更老一季,算环比
          let arrow = "";
          if (prev && prev.shares && h.shares) {
            const ch = (h.shares - prev.shares) / prev.shares;
            if (Math.abs(ch) >= 0.02) arrow = ` <span class="${ch > 0 ? "up" : "down"}">${ch > 0 ? "▲" : "▼"}${Math.abs(ch * 100).toFixed(0)}%</span>`;
          }
          return `<td title="${fmtMoney(h.value)}">${fmtShares(h.shares)}${arrow}</td>`;
        }).join("");
        return `<tr><td>${esc(f)}</td>${cells}</tr>`;
      }).join("");
      return `<div class="card"><b>${esc(sym)}</b> <span class="muted small">持股(环比)· 市值见 hover</span>
        <table>${head}${rows}</table></div>`;
    });
  $("holdings13f").innerHTML = cards.join("") || `<div class="card empty">暂无精选机构持仓(或 13F 未采集)</div>`;
}

/* ---------- 新闻页: 财报日历 ---------- */
function renderCalendar(m) {
  const rows = (m.earnings_calendar || []).filter((e) => isSel(e.symbol));
  const hourLabel = { bmo: "Pre", amc: "Post", dmh: "Intraday" };
  const today = new Date().toISOString().slice(0, 10);
  const fmtRev = (v) => v == null ? "—" : (v / 1e9).toFixed(2) + "B";
  const fmtEps = (v) => v == null ? "—" : Number(v).toFixed(2);
  $("earnings-calendar").innerHTML = rows.length ? `<table>
    <tr><th>Date</th><th>Sym</th><th>Time</th><th>EPS Est.</th><th>EPS Actual</th><th>Rev Est.</th><th>Rev Actual</th></tr>
    ${rows.map((e) => `<tr class="${e.date === today ? "today-row" : ""}">
      <td>${esc(e.date)}${e.date === today ? " ⭐" : ""}</td>
      <td><b>${esc(e.symbol)}</b></td>
      <td>${hourLabel[e.hour] || "—"}</td>
      <td>${fmtEps(e.epsEstimate)}</td>
      <td>${e.epsActual != null ? `<span class="${e.epsActual >= (e.epsEstimate ?? -1e9) ? "up" : "down"}">${fmtEps(e.epsActual)}</span>` : "—"}</td>
      <td>${fmtRev(e.revenueEstimate)}</td>
      <td>${fmtRev(e.revenueActual)}</td>
    </tr>`).join("")}
  </table>` : `<div class="empty">No earnings scheduled in window</div>`;
}

/* ---------- 信息流条目渲染 ---------- */
const feedItem = (i) => `<div class="item">
  <div class="meta"><span class="tag ${esc(i.category)}">${CAT_LABEL[i.category] || esc(i.category)}</span>${esc(i.source)} · ${timeAgo(i.published)}${i.heat != null ? ` · <span class="heat">▲ ${i.score} · 💬 ${i.comments}</span>` : ""}</div>
  <div class="title"><a href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.title)}</a></div>
  ${i.summary ? `<div class="summary">${esc(i.summary)}</div>` : ""}
</div>`;

/* ---------- 新闻页: 宏观/市场 RSS ---------- */
function renderNewsFeeds() {
  const items = (FEEDS?.items || []).filter((i) => i.category === "news" && feedMatches(i)).slice(0, 60);
  $("news-feeds").innerHTML = items.map(feedItem).join("")
    || `<div class="empty">${selected.size ? "No news matching selected tickers (matched by symbol in title/summary)" : "No content"}</div>`;
}

/* ---------- 公司新闻(Massive 带情绪 + Finnhub,合并去重) ---------- */
function renderCompanyNews(m) {
  const all = [];
  for (const [sym, d] of Object.entries(RESEARCH?.tickers || {})) {
    if (!isSel(sym)) continue;
    for (const n of d.news || []) {
      all.push({ sym, t: Date.parse(n.published) || 0, source: n.source,
                 title: n.title, url: n.url, summary: n.summary,
                 sentiment: n.sentiment, reason: n.reason });
    }
  }
  for (const [sym, list] of Object.entries(m?.company_news || {})) {
    if (!isSel(sym)) continue;
    for (const n of list || []) {
      all.push({ sym, t: (n.datetime || 0) * 1000, source: n.source,
                 title: n.headline, url: n.url, summary: (n.summary || "").slice(0, 200) });
    }
  }
  // 按 标的+标题前缀 去重(两源常收录同一篇),带情绪的优先
  all.sort((a, b) => (b.sentiment ? 1 : 0) - (a.sentiment ? 1 : 0));
  const seen = new Set();
  const deduped = all.filter((n) => {
    const key = n.sym + "|" + (n.title || "").toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => b.t - a.t);
  $("company-news").innerHTML = deduped.slice(0, 50).map((n) => {
    const s = SENTI[n.sentiment];
    return `<div class="item">
      <div class="meta"><span class="tag">${esc(n.sym)}</span>${s ? `<span class="tag ${s.cls}" title="${esc(n.reason || "")}">${s.label}</span>` : ""}${esc(n.source || "")} · ${timeAgo(new Date(n.t).toISOString())}</div>
      <div class="title"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></div>
      ${n.summary ? `<div class="summary">${esc(n.summary)}</div>` : ""}
    </div>`;
  }).join("") || `<div class="empty">No data</div>`;
}

/* ---------- 社区页 ---------- */
function renderSocialFilters() {
  const present = new Set((FEEDS?.items || []).map((i) => i.category));
  const cats = ["all", ...SOCIAL_CATS.filter((c) => present.has(c))];
  $("social-filters").innerHTML = cats.map((c) =>
    `<button data-cat="${esc(c)}" class="${c === socialCat ? "active" : ""}">${c === "all" ? "All" : (CAT_LABEL[c] || esc(c))}</button>`
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
    || `<div class="empty">${selected.size ? "No content matching selected tickers (matched by symbol in title/summary)" : "No content"}</div>`;
}

/* ---------- 错误汇总 ---------- */
function renderErrors() {
  const msgs = [
    ...(MARKET?.errors || []),
    ...((FEEDS?.errors || []).map((e) => `${e.source}: ${e.error}`)),
  ];
  $("errors").innerHTML = msgs.length
    ? `<details><summary>⚠️ ${msgs.length} data-source notice(s) (click to view)</summary><ul>${msgs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></details>`
    : "";
}

/* ---------- Tab 切换(旧的 #stock/#options/#gex 跳转到交易页) ---------- */
function initTabs() {
  const nav = $("nav");
  const names = ["home", "news", "social"];
  const toTrading = ["stock", "options", "gex"];
  const activate = (name) => {
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
    nav.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  };
  nav.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button.tab");
    if (!btn) return;
    history.replaceState(null, "", "#" + btn.dataset.tab);
    activate(btn.dataset.tab);
    window.scrollTo(0, 0);
  });
  let initial = location.hash.slice(1);
  if (initial === "overview" || initial === "feeds") initial = initial === "feeds" ? "social" : "home";
  if (toTrading.includes(initial)) { location.replace("trading.html"); return; }
  if (names.includes(initial)) activate(initial);
}

function renderAll() {
  renderTickerFilter();
  render13f();
  if (MARKET) {
    renderCalendar(MARKET);
    renderCompanyNews(MARKET);
  }
  if (FEEDS) { renderNewsFeeds(); renderSocial(); }
  renderErrors();
}

/* ---------- 入口 ---------- */
(async function main() {
  initTabs();
  initTickerFilter();
  initSocialFilters();

  [MARKET, FEEDS, RESEARCH, HOLD13F] = await Promise.all([
    loadJSON("data/market.json"),
    loadJSON("data/feeds.json"),
    loadFreshJSON("data/research.json"),
    loadJSON("data/holdings13f.json"),
  ]);

  // watchlist 变动后清掉已失效的选择
  const watch = new Set(MARKET?.watchlist || []);
  selected = new Set([...selected].filter((s) => watch.has(s)));

  const times = [MARKET?.updated_at, FEEDS?.updated_at].filter(Boolean);
  $("updated").textContent = times.length
    ? "Last update: " + fmtDT(times.sort().at(-1))
    : "No data yet — run a fetch script or GitHub Actions first";

  renderSocialFilters();
  renderAll();
})();
