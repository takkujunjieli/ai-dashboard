/* 股市信息 Dashboard — 纯前端渲染,从 data/*.json 读取抓取结果 */

const $ = (id) => document.getElementById(id);
const esc = (t) => { const d = document.createElement("div"); d.textContent = t ?? ""; return d.innerHTML; };
const fmtDT = (iso) => iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—";
const CAT_LABEL = { news: "新闻", kol: "大V", youtube: "视频", community: "社区" };

function timeAgo(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
}

async function loadJSON(path) {
  try {
    const r = await fetch(path + "?t=" + Date.now());
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch { return null; }
}

/* ---------- 行情条 ---------- */
function renderQuotes(m) {
  const el = $("quotes-strip");
  const syms = m.watchlist || Object.keys(m.quotes || {});
  el.innerHTML = syms.map((s) => {
    const q = (m.quotes || {})[s];
    if (!q || q.c == null) return "";
    const cls = q.d >= 0 ? "up" : "down";
    const sign = q.d >= 0 ? "+" : "";
    return `<div class="quote-card">
      <div class="sym">${esc(s)}</div>
      <div class="price">${q.c.toFixed(2)}</div>
      <div class="chg ${cls}">${sign}${q.d?.toFixed(2)} (${sign}${q.dp?.toFixed(2)}%)</div>
    </div>`;
  }).join("") || `<div class="empty">暂无行情数据(检查 FINNHUB_API_KEY)</div>`;
}

/* ---------- 财报日历 ---------- */
function renderCalendar(m) {
  const rows = m.earnings_calendar || [];
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
  </table>` : `<div class="empty">窗口期内 watchlist 没有财报安排</div>`;
}

/* ---------- 最近财报 EPS surprise ---------- */
function renderSurprises(m) {
  const data = m.earnings_surprises || {};
  const cards = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length).map(([sym, list]) => {
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

/* ---------- 分析师评级 ---------- */
function renderRecommendations(m) {
  const data = m.recommendations || {};
  const rows = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length).map(([sym, list]) => {
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

/* ---------- 公司新闻(Finnhub),按股票筛选 ---------- */
function renderCompanyNews(m) {
  const all = [];
  for (const [sym, list] of Object.entries(m.company_news || {})) {
    for (const n of list || []) all.push({ ...n, sym });
  }
  all.sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
  const syms = ["all", ...new Set(all.map((n) => n.sym))];
  let active = "all";

  const draw = () => {
    const shown = all.filter((n) => active === "all" || n.sym === active).slice(0, 50);
    $("company-news").innerHTML = shown.map((n) => `<div class="item">
      <div class="meta"><span class="tag">${esc(n.sym)}</span>${esc(n.source || "")} · ${timeAgo(new Date((n.datetime || 0) * 1000).toISOString())}</div>
      <div class="title"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.headline)}</a></div>
      ${n.summary ? `<div class="summary">${esc(n.summary.slice(0, 200))}</div>` : ""}
    </div>`).join("") || `<div class="empty">暂无数据</div>`;
  };

  $("news-filters").innerHTML = syms.map((s) =>
    `<button data-sym="${esc(s)}" class="${s === active ? "active" : ""}">${s === "all" ? "全部" : esc(s)}</button>`
  ).join("");
  $("news-filters").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    active = btn.dataset.sym;
    [...$("news-filters").children].forEach((b) => b.classList.toggle("active", b === btn));
    draw();
  });
  draw();
}

/* ---------- 信息流(RSS) ---------- */
function renderFeeds(f) {
  const items = f.items || [];
  const cats = ["all", ...new Set(items.map((i) => i.category))];
  let active = "all";

  const draw = () => {
    let shown = items.filter((i) => active === "all" || i.category === active);
    if (active === "community") {
      // 社区帖按热度(点赞 + 2×评论)排序,无热度数据时退回时间序
      shown = [...shown].sort((a, b) =>
        (b.heat || 0) - (a.heat || 0) || (b.published || "").localeCompare(a.published || ""));
    }
    shown = shown.slice(0, 120);
    $("feeds").innerHTML = shown.map((i) => `<div class="item">
      <div class="meta"><span class="tag ${esc(i.category)}">${CAT_LABEL[i.category] || esc(i.category)}</span>${esc(i.source)} · ${timeAgo(i.published)}${i.heat != null ? ` · <span class="heat">▲ ${i.score} · 💬 ${i.comments}</span>` : ""}</div>
      <div class="title"><a href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.title)}</a></div>
      ${i.summary ? `<div class="summary">${esc(i.summary)}</div>` : ""}
    </div>`).join("") || `<div class="empty">暂无内容</div>`;
  };

  $("feed-filters").innerHTML = cats.map((c) =>
    `<button data-cat="${esc(c)}" class="${c === active ? "active" : ""}">${c === "all" ? "全部" : (CAT_LABEL[c] || esc(c))}</button>`
  ).join("");
  $("feed-filters").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    active = btn.dataset.cat;
    [...$("feed-filters").children].forEach((b) => b.classList.toggle("active", b === btn));
    draw();
  });
  draw();
}

/* ---------- 错误汇总 ---------- */
function renderErrors(m, f) {
  const msgs = [
    ...(m?.errors || []),
    ...((f?.errors || []).map((e) => `${e.source}: ${e.error}`)),
  ];
  $("errors").innerHTML = msgs.length
    ? `<details><summary>⚠️ ${msgs.length} 个数据源抓取失败(点开查看)</summary><ul>${msgs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></details>`
    : "";
}

/* ---------- Tab 切换(支持 #news / #feeds 直达) ---------- */
function initTabs() {
  const nav = $("nav");
  const names = ["overview", "news", "feeds"];
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
  const initial = location.hash.slice(1);
  if (names.includes(initial)) activate(initial);
}

/* ---------- 入口 ---------- */
(async function main() {
  initTabs();
  const [market, feeds] = await Promise.all([
    loadJSON("data/market.json"),
    loadJSON("data/feeds.json"),
  ]);

  const times = [market?.updated_at, feeds?.updated_at].filter(Boolean);
  $("updated").textContent = times.length
    ? "最后更新: " + fmtDT(times.sort().at(-1))
    : "还没有数据 — 先运行一次抓取脚本或 GitHub Actions";

  if (market) {
    renderQuotes(market);
    renderCalendar(market);
    renderSurprises(market);
    renderRecommendations(market);
    renderCompanyNews(market);
  }
  if (feeds) renderFeeds(feeds);
  renderErrors(market, feeds);
})();
