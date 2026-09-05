/* 策略回测页(PR7):读 data/strategy_bt.json,渲染统计 + 指标 + 权益曲线(叠加基准)+ OOS + 交易。只读。 */
import { $, esc, loadJSON, loadFreshJSON, getPat, setPat, ghHeaders, REPO } from "./shared.js";
const LWC = window.LightweightCharts;

/* 账户风险控制 · 仓位计算器 + bundle 管理。读/写 config/risk_policy.json(日后 agentic 读同一份)。
   每个 bundle = 单笔风险% + ATR倍数 + 仓位上限%;止损决定仓位 shares=净值×risk%÷(entry−stop)。 */
// 两个入口(bundles / assignments)都写同一个 risk_policy.json。为避免互相覆盖 + sha 冲突(409):
// 每次都先拉「最新内容+sha」,只改自己那块(mutate),再 PUT;409(sha 过期)自动重取重试一次。
async function putPolicy(mutate) {
  const pat = getPat();
  if (!pat) return { ok: false, msg: "需 fine-grained PAT(与采集面板共用,存本机);未写仓库" };
  const url = `https://api.github.com/repos/${REPO}/contents/config/risk_policy.json`;
  async function once() {
    let sha, latest = {};
    try {
      const c = await fetch(url + "?ref=main&t=" + Date.now(), { headers: ghHeaders(pat), cache: "no-store" });
      if (c.ok) { const j = await c.json(); sha = j.sha; latest = JSON.parse(decodeURIComponent(escape(atob((j.content || "").replace(/\s/g, ""))))); }
    } catch { /* 新建或解析失败 → 从空开始 */ }
    mutate(latest);
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(latest, null, 2) + "\n")));
    return fetch(url, { method: "PUT", headers: ghHeaders(pat),
      body: JSON.stringify({ message: "chore: update risk_policy via strategy UI", content, sha, branch: "main" }) });
  }
  try {
    let r = await once();
    if (r.status === 409) r = await once();   // sha 过期 → 重取最新再试一次
    return r.ok ? { ok: true } : { ok: false, msg: "PUT 失败 " + r.status };
  } catch (e) { return { ok: false, msg: String(e) }; }
}

export async function renderRiskControl() {
  const host = $("risk-control"); if (!host) return;
  let POLICY = (await loadJSON("config/risk_policy.json")) || {};
  if (!POLICY.bundles || !Object.keys(POLICY.bundles).length) {
    POLICY = { account_equity: 100000, atr_period: 14, default_bundle: "常规",
      bundles: { "常规": { risk_pct: 0.75, atr_mult: 2.0, max_position_pct: 20 } },
      stop_bases: (POLICY && POLICY.stop_bases) || [] };
  }
  // 本机 localStorage 覆盖(bundle 编辑即时本地持久化,免 PAT;刷新不丢);"保存到 config" 再发布给 agent
  const loc = rLS("riskPolicy", null);
  if (loc && loc.bundles && Object.keys(loc.bundles).length) {
    POLICY.bundles = loc.bundles;
    if (loc.default_bundle) POLICY.default_bundle = loc.default_bundle;
    if (loc.account_equity != null) POLICY.account_equity = loc.account_equity;
  }
  const atrP = POLICY.atr_period ?? 14;
  let cur = (POLICY.default_bundle && POLICY.bundles[POLICY.default_bundle]) ? POLICY.default_bundle : Object.keys(POLICY.bundles)[0];
  const g = (id) => +$(id).value;
  const persistLocal = () => rLSset("riskPolicy", { bundles: POLICY.bundles, default_bundle: cur, account_equity: g("rk-eq") });
  const T = (k, v, sb = "", cls = "") => `<div class="opt-tile"><div class="opt-k">${k}</div><div class="opt-v ${cls}">${v}${sb ? ` <span class="opt-sub">${sb}</span>` : ""}</div></div>`;
  const bundleOpts = () => Object.keys(POLICY.bundles).map((k) => `<option value="${esc(k)}"${k === cur ? " selected" : ""}>${esc(k)}</option>`).join("");

  host.innerHTML = `
    <div class="risk-bundles">
      <label>Bundle<select id="rk-bundle">${bundleOpts()}</select></label>
      <label>单笔风险 %<input id="rk-risk" type="number" step="0.05" style="width:82px"></label>
      <label>ATR 倍数<input id="rk-mult" type="number" step="0.1" style="width:72px"></label>
      <label>仓位上限 %<input id="rk-cap" type="number" step="1" style="width:82px"></label>
      <input id="rk-newname" type="text" placeholder="新 bundle 名" style="width:110px">
      <button id="rk-new" class="mini-btn">＋新建</button>
      <button id="rk-del" class="mini-btn">删除</button>
      <input id="rk-pat" type="password" value="${esc(getPat() || "")}" placeholder="fine-grained PAT(本机存)" style="width:180px;background:var(--card-hover);border:1px solid var(--border);border-radius:6px;padding:5px 8px;color:var(--text);font-size:12px">
      <button id="rk-save" class="mini-btn">💾 保存到 config(bundles + 分组 + 上限)</button>
      <span id="rk-msg" class="muted small"></span>
    </div>
    <div class="risk-form" style="margin-top:12px">
      <label>账户净值 $<input id="rk-eq" type="number" step="1000" value="${POLICY.account_equity ?? 100000}"></label>
      <label>买入价 $<input id="rk-entry" type="number" step="0.01" value="100"></label>
      <label>止损法<select id="rk-mode"><option value="manual">手动止损价</option><option value="atr">ATR 法</option></select></label>
      <label id="rk-stop-wrap">止损价 $<input id="rk-stop" type="number" step="0.01" value="94"></label>
      <label id="rk-atr-wrap" style="display:none">ATR${atrP} $<input id="rk-atr" type="number" step="0.01" value="3"></label>
    </div>
    <div id="rk-out" class="wb-statbar" style="margin-top:12px"></div>
    <div id="rk-note" class="muted small" style="margin-top:6px"></div>
    <div class="muted small" style="margin-top:10px"><b>止损放在 thesis 被证伪处</b>(不是"亏 X% 就卖"):${(POLICY.stop_bases || []).map(esc).join(" · ")}。<br>核心:<b>止损位决定仓位</b>;每个 bundle 自带 单笔风险%/ATR倍数/仓位上限。ATR 法:止损=买入−倍数×ATR${atrP}。</div>`;

  const loadBundle = () => { const b = POLICY.bundles[cur] || {}; $("rk-risk").value = b.risk_pct ?? 0.75; $("rk-mult").value = b.atr_mult ?? 2.0; $("rk-cap").value = b.max_position_pct ?? 20; };
  const syncBundle = () => { const b = POLICY.bundles[cur] || (POLICY.bundles[cur] = {}); b.risk_pct = g("rk-risk"); b.atr_mult = g("rk-mult"); b.max_position_pct = g("rk-cap"); };

  function compute() {
    const b = POLICY.bundles[cur] || {};
    const eq = g("rk-eq"), entry = g("rk-entry");
    const riskPct = b.risk_pct || 0.75, mult = b.atr_mult || 2.0, maxPos = b.max_position_pct || 20;
    const mode = $("rk-mode").value;
    $("rk-stop-wrap").style.display = mode === "manual" ? "" : "none";
    $("rk-atr-wrap").style.display = mode === "atr" ? "" : "none";
    const stop = mode === "manual" ? g("rk-stop") : entry - mult * g("rk-atr");
    const budget = eq * riskPct / 100, perShare = entry - stop;
    const out = $("rk-out"), note = $("rk-note");
    if (!(eq > 0) || !(entry > 0) || !(perShare > 0)) {
      out.innerHTML = T("提示", "—", "止损须在买入价下方");
      note.textContent = mode === "atr" && entry > 0 ? `ATR 止损 = ${entry} − ${mult}×${g("rk-atr")} = ${stop.toFixed(2)}` : "";
      return;
    }
    let shares = Math.floor(budget / perShare), posDollar = shares * entry, posPct = posDollar / eq * 100, capped = false;
    if (posPct > maxPos) { capped = true; shares = Math.floor(eq * maxPos / 100 / entry); posDollar = shares * entry; posPct = posDollar / eq * 100; }
    const actualRisk = shares * perShare;
    out.innerHTML = [
      T("风险预算", "$" + budget.toFixed(0), `${riskPct}% × 净值`, "down"),
      T("止损价", "$" + stop.toFixed(2), `每股风险 $${perShare.toFixed(2)}`),
      T("仓位股数", shares.toLocaleString(), capped ? `压到 ${maxPos}% 上限` : "", "up"),
      T("仓位金额", "$" + posDollar.toFixed(0), `${posPct.toFixed(1)}% 净值`),
      T("实际风险", "$" + actualRisk.toFixed(0), `${(actualRisk / eq * 100).toFixed(2)}% 净值`, "down"),
    ].join("");
    note.innerHTML = `${shares.toLocaleString()} 股 = 预算 $${budget.toFixed(0)} ÷ 每股风险 $${perShare.toFixed(2)}`
      + (capped ? ` · <span class="down">触发 ${maxPos}% 仓位上限 → 压低股数</span>` : "")
      + (mode === "atr" ? ` · ATR 止损 = ${entry} − ${mult}×${g("rk-atr")} = ${stop.toFixed(2)}` : "");
  }

  $("rk-bundle").addEventListener("change", () => { cur = $("rk-bundle").value; loadBundle(); compute(); persistLocal(); renderRiskExposure(); });
  ["rk-risk", "rk-mult", "rk-cap"].forEach((id) => { const el = $(id); el.addEventListener("input", () => { syncBundle(); compute(); persistLocal(); }); el.addEventListener("change", renderRiskExposure); });   // change(失焦/回车)时刷新热力表止损/在险
  ["rk-eq", "rk-entry", "rk-stop", "rk-atr"].forEach((id) => $(id).addEventListener("input", compute));
  $("rk-eq").addEventListener("input", persistLocal);
  $("rk-mode").addEventListener("change", compute);
  $("rk-new").addEventListener("click", () => {
    const name = ($("rk-newname").value || "").trim();
    if (!name) return void ($("rk-msg").textContent = "先填 bundle 名");
    if (POLICY.bundles[name]) return void ($("rk-msg").textContent = "同名已存在");
    POLICY.bundles[name] = { risk_pct: 0.75, atr_mult: 2.0, max_position_pct: 20 };
    cur = name; $("rk-bundle").innerHTML = bundleOpts(); $("rk-newname").value = "";
    loadBundle(); compute(); persistLocal(); $("rk-msg").textContent = `已建「${name}」· 本地已存,记得点保存发布给 agent`;
  });
  $("rk-del").addEventListener("click", () => {
    if (Object.keys(POLICY.bundles).length <= 1) return void ($("rk-msg").textContent = "至少保留 1 个 bundle");
    delete POLICY.bundles[cur]; cur = Object.keys(POLICY.bundles)[0];
    $("rk-bundle").innerHTML = bundleOpts(); loadBundle(); compute(); persistLocal(); $("rk-msg").textContent = "已删除 · 本地已存,记得点保存发布给 agent";
  });
  const pt = $("rk-pat"); if (pt) pt.addEventListener("change", () => { setPat(pt.value.trim()); $("rk-msg").textContent = pt.value.trim() ? "✓ PAT 已存本机" : "PAT 已清"; });
  $("rk-save").addEventListener("click", async () => {
    syncBundle(); POLICY.account_equity = g("rk-eq"); POLICY.default_bundle = cur;
    $("rk-msg").textContent = "保存中…";
    const r = await putPolicy((L) => { const { assignments, ...rest } = POLICY; Object.assign(L, rest); if (ASSIGN) L.assignments = ASSIGN; if (MAXHEAT != null) L.portfolio = { ...(L.portfolio || {}), max_total_heat_pct: MAXHEAT }; });  // bundles + 分组 + 组合上限 一起写
    $("rk-msg").textContent = r.ok ? "✓ 已保存 bundles + 分组到 config(agent 读同一份)" : "✗ " + r.msg;
  });

  loadBundle(); compute();
}

const tile = (k, v, sub = "", cls = "") =>
  `<div class="opt-tile"><div class="opt-k">${k}</div><div class="opt-v ${cls}">${v}${sub ? ` <span class="opt-sub">${sub}</span>` : ""}</div></div>`;
const num = (v, d = 2) => (v == null ? "—" : (+v).toFixed(d));
const pct = (v) => (v == null ? "—" : ((v >= 0 ? "+" : "") + v + "%"));
const upcls = (v) => ((v ?? 0) >= 0 ? "up" : "down");
const toT = (t) => (typeof t === "number" ? t : Math.floor(Date.parse(t) / 1000));

function lineData(curve) {  // LWC 要求 time 严格递增且唯一
  const seen = new Set(), out = [];
  for (const p of curve || []) {
    const t = toT(p.t);
    if (Number.isFinite(t) && !seen.has(t)) { seen.add(t); out.push({ time: t, value: p.equity }); }
  }
  return out.sort((a, b) => a.time - b.time);
}

/* 风险敞口热力图(本地专用)。读 data/portfolio.json + data/atr.json + risk_policy 的 bundle。
   现价口径:open risk=|股数|×|现价−止损|;止损=ATR法(现价∓bundle.ATR倍数×ATR14),可每仓手填覆盖。
   多列绿→红:在险% / 在险÷预算 / 仓位%vs上限 / 距止损% / 浮盈%。+ 组合总在险 heat + 分 bundle 小计。
   分组/止损/净值 存本机 localStorage(不上仓库,honors 隐私)。 */
const rLS = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const rLSset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const heatBg = (lvl) => { const l = Math.max(0, Math.min(1, lvl || 0)); return `background:hsl(${Math.round(142 * (1 - l))} 65% 45% / ${(0.08 + l * 0.42).toFixed(2)})`; };
let ASSIGN = null;   // {sym: bundle} 内存态(含未保存改动),来源 risk_policy.json 的 assignments
let MAXHEAT = null;  // 组合总在险上限%(内存态;本机 localStorage 即时持久化,「保存到 config」再推给 agent)
let SORT = { key: "riskPct", dir: -1 };   // 热力表排序(点表头切换;文本默认升序、数值默认降序;null 永远排最后)
let PRICE_OVERRIDE = null, PRICE_SYNCED_AT = null;   // 「同步现价」按钮从 K线快照拉到的最新价

function sortRows(rows) {
  const { key, dir } = SORT, strK = key === "sym" || key === "bundleName";
  return rows.slice().sort((a, b) => {
    const va = a[key], vb = b[key];
    if (strK) return dir * String(va || "").localeCompare(String(vb || ""));
    if (va == null && vb == null) return 0;
    if (va == null) return 1; if (vb == null) return -1;   // 缺值排最后
    return dir * (va - vb);
  });
}

export async function renderRiskExposure() {
  const host = $("risk-expo"), heatEl = $("risk-heat"); if (!host) return;
  const [pf, atrJ, P, researchJ] = await Promise.all([
    loadJSON("data/portfolio.json"), loadJSON("data/atr.json"), loadJSON("config/risk_policy.json"),
    loadJSON("data/research.json")]);
  const snap = (researchJ && researchJ.snapshots) || {};   // 每票 K线快照:{price,chg,...}
  if (!pf || !Array.isArray(pf.positions) || !pf.positions.length) {
    if (heatEl) heatEl.innerHTML = '<span class="muted small">本地专用:需 data/portfolio.json(gitignored,公开站不显示)。本地刷新持仓后可见。</span>';
    host.innerHTML = ""; return;
  }
  const ATR = (atrJ && atrJ.atr14) || {};
  const LP = rLS("riskPolicy", {});   // bundle 编辑器的本机即时态,优先于 config 文件,让改动立刻反映到热力表
  const bundles = LP.bundles || (P && P.bundles) || { "常规": { risk_pct: 0.75, atr_mult: 2.0, max_position_pct: 20 } };
  const bnames = Object.keys(bundles);
  const dfb = LP.default_bundle || (P && P.default_bundle);
  const defB = (dfb && bundles[dfb]) ? dfb : bnames[0];
  if (MAXHEAT === null) MAXHEAT = +rLS("riskMaxHeat", (P && P.portfolio && P.portfolio.max_total_heat_pct) ?? 6);
  const maxHeat = MAXHEAT;
  if (ASSIGN === null) ASSIGN = { ...((P && P.assignments) || {}), ...rLS("riskGroups", {}) };  // 本机 localStorage 覆盖(本地即时持久化,无需 PAT);「发布到 config」再推给 agent
  const stops = rLS("riskStops", {});
  // 账户净值直接从 portfolio.json 读:按账户(全部/各账户)汇总持仓市值
  const accounts = pf.accounts || [];
  const acctSel = rLS("riskAccount", "ALL");
  const positions = pf.positions.filter((p) => acctSel === "ALL" || p.account === acctSel);
  // 净值:每账户优先用 portfolio.json 的 net liq(build_portfolio 从 MCP get_portfolio 带出),缺则回退该账户持仓市值合计
  const acctMV = {};
  for (const p of pf.positions) acctMV[p.account] = (acctMV[p.account] || 0) + (p.mkt_value || 0);
  const acctEq = (a) => (a && a.equity != null) ? a.equity : (acctMV[a && a.id] || 0);
  let equity, eqSrc;
  if (acctSel === "ALL") {
    equity = accounts.reduce((s, a) => s + acctEq(a), 0);
    eqSrc = accounts.length && accounts.every((a) => a.equity != null) ? "net liq" : "net liq/持仓市值 混合";
  } else {
    const a = accounts.find((x) => x.id === acctSel);
    equity = acctEq(a); eqSrc = (a && a.equity != null) ? "net liq" : "持仓市值合计";
  }
  if (!(equity > 0)) { equity = positions.reduce((s, p) => s + Math.abs(p.mkt_value || 0), 0) || 1; eqSrc = "持仓市值合计"; }

  const rows = []; let totalHeat = 0; const heatByBundle = {};
  for (const p of positions) {
    const sym = p.sym, qty = p.qty || 0; if (!qty) continue;
    const isOpt = p.kind !== "equity", long = qty > 0;
    // 现价优先级:同步按钮拉到的 K线价 > research.json 本地快照 > portfolio.json(期权无 K线快照,仍用原价)
    const price = (!isOpt && PRICE_OVERRIDE && PRICE_OVERRIDE[sym] != null) ? PRICE_OVERRIDE[sym]
                : (!isOpt && snap[sym] && snap[sym].price != null) ? snap[sym].price : p.price;
    const bundleName = ASSIGN[sym] || defB, b = bundles[bundleName] || bundles[defB];
    const budget = equity * (b.risk_pct || 0.75) / 100, atr = ATR[sym];
    let stop = stops[sym] != null ? +stops[sym]
             : (atr != null && price != null ? (long ? price - b.atr_mult * atr : price + b.atr_mult * atr) : null);
    const perShare = (stop != null && price != null) ? (long ? price - stop : stop - price) : null;
    let openRisk = isOpt ? Math.abs(p.mkt_value || 0) : (perShare != null ? Math.abs(qty) * perShare : null);
    if (openRisk != null && openRisk < 0) openRisk = 0;                 // 止损已锁利 → 不占风险
    const posPct = Math.abs(p.mkt_value || 0) / equity * 100;
    const riskPct = openRisk != null ? openRisk / equity * 100 : null;
    const ratio = openRisk != null ? openRisk / budget : null;
    const distPct = (perShare != null && price) ? perShare / price * 100 : null;
    if (openRisk != null) { totalHeat += openRisk; heatByBundle[bundleName] = (heatByBundle[bundleName] || 0) + openRisk; }
    // 浮盈%:股票用现价算,做空取反(价跌为盈);期权回退 portfolio.json 的 pnl_pct
    const pnlPct = (!isOpt && p.avg_cost && price != null)
      ? (long ? (price / p.avg_cost - 1) : (1 - price / p.avg_cost)) * 100
      : (p.pnl_pct != null ? p.pnl_pct * 100 : null);
    rows.push({ sym, isOpt, long, qty, price, cost: p.avg_cost, stop, atr, bundleName, cap: b.max_position_pct || 20,
                openRisk, riskPct, ratio, posPct, distPct, pnlPct });
  }
  const disp = sortRows(rows);

  const cell = (txt, lvl) => `<td class="sc-num"${lvl == null ? "" : ` style="${heatBg(lvl)}"`}>${txt}</td>`;
  const pnlCell = (v) => { if (v == null) return "<td>—</td>"; const l = Math.min(Math.abs(v) / 40, 1), hue = v >= 0 ? 142 : 0; return `<td class="sc-num" style="background:hsl(${hue} 65% 45% / ${(0.06 + l * 0.34).toFixed(2)})">${v >= 0 ? "+" : ""}${v.toFixed(0)}%</td>`; };
  const grpSel = (r) => `<select class="rk-grp" data-sym="${esc(r.sym)}">${bnames.map((k) => `<option${k === r.bundleName ? " selected" : ""}>${esc(k)}</option>`).join("")}</select>`;
  const stopIn = (r) => `<input class="rk-stopin" data-sym="${esc(r.sym)}" type="number" step="0.01" value="${r.stop != null ? r.stop.toFixed(2) : ""}" placeholder="${r.isOpt ? "期权" : (r.atr != null ? "ATR" : "手填")}" style="width:70px">`;
  const arrow = (k) => SORT.key === k ? (SORT.dir < 0 ? " ↓" : " ↑") : "";
  const sth = (k, label) => `<th class="rk-sort" data-k="${k}" style="cursor:pointer;user-select:none;white-space:nowrap">${label}${arrow(k)}</th>`;
  const body = disp.map((r) => `<tr>
    <td class="sc-tk"><b>${esc(r.sym)}</b> <span class="sc-dir ${r.long ? "up" : "down"}">${r.isOpt ? "期" : r.long ? "多" : "空"}</span></td>
    <td>${grpSel(r)}</td><td>${r.qty}</td><td>$${r.price != null ? r.price.toFixed(2) : "—"}</td>
    <td class="muted">$${r.cost != null ? r.cost.toFixed(2) : "—"}</td><td>${stopIn(r)}</td>
    ${cell(r.riskPct != null ? r.riskPct.toFixed(2) + "%" : "—", r.riskPct == null ? null : Math.min(r.riskPct / 2, 1))}
    ${cell(r.ratio != null ? r.ratio.toFixed(2) + "×" : "—", r.ratio == null ? null : Math.min(r.ratio / 1.5, 1))}
    ${cell(r.posPct.toFixed(1) + "%", Math.min(r.posPct / r.cap, 1))}
    ${cell(r.distPct != null ? r.distPct.toFixed(1) + "%" : "—", r.distPct == null ? null : Math.max(0, Math.min(1, 1 - r.distPct / 15)))}
    ${pnlCell(r.pnlPct)}</tr>`).join("");

  host.innerHTML = `<div class="sc-wrap"><table class="sc-table">
    <tr>${sth("sym", "标的")}${sth("bundleName", "组")}<th>股数</th><th>现价</th><th>成本</th><th>止损</th>
        ${sth("riskPct", "在险%")}${sth("ratio", "在险/预算")}${sth("posPct", "仓位%")}${sth("distPct", "距止损%")}${sth("pnlPct", "浮盈%")}</tr>${body}</table></div>
    <div class="muted small" style="margin-top:8px">在险%=|股数|×|现价−止损|÷净值 · 在险/预算=该仓在险÷所属 bundle 单笔预算(>1 超险)· 仓位%对比 bundle 上限 · 距止损%小=逼近止损 · 浮盈%仅参考(现价口径,成本不进风险)。止损默认 ATR 法,可每仓手填覆盖(存本机)。</div>`;

  const totalPct = totalHeat / equity * 100;
  heatEl.innerHTML = `<div class="wb-statbar">
    <div class="opt-tile"><div class="opt-k">账户</div><div class="opt-v"><select id="rk-acct" style="background:var(--card-hover);border:1px solid var(--border);border-radius:6px;padding:3px 6px;color:var(--text);font-size:13px">${["ALL", ...accounts.map((a) => a.id)].map((id) => `<option value="${esc(id)}"${id === acctSel ? " selected" : ""}>${esc(id === "ALL" ? "全部" : (accounts.find((a) => a.id === id) || {}).label || id)}</option>`).join("")}</select></div></div>
    <div class="opt-tile"><div class="opt-k">账户净值(portfolio)</div><div class="opt-v">$${Math.round(equity).toLocaleString()}</div><div class="opt-sub">${eqSrc}</div></div>
    <div class="opt-tile"><div class="opt-k">组合总在险 heat</div><div class="opt-v" style="${heatBg(Math.min(totalPct / maxHeat, 1))};border-radius:6px;padding:1px 8px">$${Math.round(totalHeat).toLocaleString()} · ${totalPct.toFixed(2)}%</div><div class="opt-sub">上限 <input id="rk-maxheat" type="number" step="0.5" value="${maxHeat}" style="width:52px;background:var(--card-hover);border:1px solid var(--border);border-radius:5px;padding:1px 5px;color:var(--text);font-size:12px"> % 净值</div></div>
    ${bnames.filter((k) => heatByBundle[k]).map((k) => `<div class="opt-tile"><div class="opt-k">${esc(k)} 在险</div><div class="opt-v">$${Math.round(heatByBundle[k]).toLocaleString()} · ${(heatByBundle[k] / equity * 100).toFixed(2)}%</div></div>`).join("")}</div>
    <div class="muted small" style="margin-top:6px">组合总在险 = 所有持仓在险之和(若止损全被打的总亏损)。${totalPct > maxHeat ? `<span class="down">⚠️ 超总上限 ${maxHeat}%,考虑减仓/收紧止损</span>` : "在上限内。"}</div>
    <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button id="rk-syncpx" class="mini-btn">🔄 同步现价(K线)</button>
      <span class="muted small">现价源:${PRICE_OVERRIDE ? `K线同步 @ ${(PRICE_SYNCED_AT || "").slice(5, 16).replace("T", " ")}` : (Object.keys(snap).length ? `research.json 快照 @ ${((researchJ && researchJ.updated_at) || "").slice(5, 16).replace("T", " ")}` : "portfolio.json")}</span>
    </div>
    <div class="muted small" style="margin-top:6px">分组改动已本地自动保存(localStorage);点顶部「💾 保存到 config」把 bundles + 分组一起发布给 agent(需 PAT)。</div>`;

  host.querySelectorAll(".rk-grp").forEach((el) => el.addEventListener("change", () => { ASSIGN[el.dataset.sym] = el.value; const g = rLS("riskGroups", {}); g[el.dataset.sym] = el.value; rLSset("riskGroups", g); renderRiskExposure(); }));
  const mh = $("rk-maxheat"); if (mh) mh.addEventListener("change", () => { MAXHEAT = +mh.value || 0; rLSset("riskMaxHeat", MAXHEAT); renderRiskExposure(); });   // 本机即时持久化;「保存到 config」再推给 agent
  host.querySelectorAll(".rk-sort").forEach((th) => th.addEventListener("click", () => {   // 点表头排序:同列切方向,换列文本升/数值降
    const k = th.dataset.k;
    SORT = SORT.key === k ? { key: k, dir: -SORT.dir } : { key: k, dir: (k === "sym" || k === "bundleName") ? 1 : -1 };
    renderRiskExposure();
  }));
  host.querySelectorAll(".rk-stopin").forEach((el) => el.addEventListener("change", () => { const s = rLS("riskStops", {}), v = el.value.trim(); if (v === "") delete s[el.dataset.sym]; else s[el.dataset.sym] = +v; rLSset("riskStops", s); renderRiskExposure(); }));
  const ac = $("rk-acct"); if (ac) ac.addEventListener("change", () => { rLSset("riskAccount", ac.value); renderRiskExposure(); });
  const sp = $("rk-syncpx"); if (sp) sp.addEventListener("click", async () => {
    sp.textContent = "同步中…";
    const r = await loadFreshJSON("data/research.json");   // 从 data 分支拉最新 K线快照(比本地文件新)
    const s = (r && r.snapshots) || {};
    if (Object.keys(s).length) {
      PRICE_OVERRIDE = {};
      for (const k in s) if (s[k] && s[k].price != null) PRICE_OVERRIDE[k] = s[k].price;
      PRICE_SYNCED_AT = r.updated_at || new Date().toISOString();
    }
    renderRiskExposure();
  });
}

/* 组合稳健性:累计 $P&L(M2M,含未实现)曲线 + 对 SPY 的 β/α。读 data/robustness.json(本地/私有)。
   时间范围切换:曲线从窗口起点归零重画、统计只算该窗口。 */
let ROBUST = null;
const ROBUST_COL = { _all: "#60a5fa", "rh-7159": "#34d399", "takku-rh-2566": "#fbbf24" };

export async function renderRobust() {
  const el = $("robust-chart"); if (!el) return;
  const sec = $("sec-robust");
  ROBUST = await loadFreshJSON("data/robustness.json");
  if (!ROBUST || !ROBUST.accounts) { if (sec) sec.style.display = "none"; return; }
  const rg = $("robust-range");
  if (rg) rg.addEventListener("click", (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    [...rg.children].forEach((x) => x.classList.toggle("active", x === b));
    drawRobust(b.dataset.w);
  });
  drawRobust("ytd");   // 默认 2026 以来
}

function drawRobust(win) {
  const r = ROBUST, el = $("robust-chart"); if (!r || !el) return;
  const start = (r.window_starts && r.window_starts[win]) || "1900-01-01";
  el.innerHTML = "";   // 重画
  const chart = LWC.createChart(el, {
    layout: { background: { color: "transparent" }, textColor: "#8b96ad" },
    grid: { vertLines: { color: "#1e2941" }, horzLines: { color: "#1e2941" } },
    rightPriceScale: { borderColor: "#2a3550" }, timeScale: { borderColor: "#2a3550" }, height: 320,
  });
  const order = ["_all", ...Object.keys(r.accounts).filter((k) => k !== "_all")];
  const legend = [];
  order.forEach((k, i) => {   // 曲线:各账户 总累计$P&L(curve[*][1]),窗口起点归零
    const o = r.accounts[k]; if (!o || !o.curve || !o.curve.length) return;
    const sliced = o.curve.filter((row) => row[0] >= start);
    if (!sliced.length) return;
    const base = sliced[0][1];
    const col = ROBUST_COL[k] || `hsl(${i * 70} 60% 60%)`;
    const seen = new Set(), data = [];
    for (const row of sliced) if (!seen.has(row[0])) { seen.add(row[0]); data.push({ time: row[0], value: row[1] - base }); }
    chart.addLineSeries({ color: col, lineWidth: k === "_all" ? 2 : 1, priceLineVisible: false, lastValueVisible: false }).setData(data);
    const last = sliced[sliced.length - 1][1] - base;
    legend.push(`<span class="rt-leg"><span class="rt-sw" style="background:${col}"></span>${esc(o.label)} <b class="${last >= 0 ? "up" : "down"}">${last >= 0 ? "+" : "−"}$${Math.abs(Math.round(last)).toLocaleString()}</b></span>`);
  });
  chart.timeScale().fitContent();
  $("robust-legend").innerHTML = legend.join("");
  // ── 统计:总收益 β/α/Sharpe + bootstrap CI + 显著性;多空腿归因 ──
  const c = (v, s = "") => (v == null ? "—" : v + s);
  const a = (v) => `class="${(v ?? 0) >= 0 ? "up" : "down"}"`;
  const ciS = (ci) => (ci ? ` <span class="muted" style="font-size:10px">[${ci[0]},${ci[1]}]</span>` : "");
  const trs = order.map((k) => {
    const o = r.accounts[k], w = (o.windows && o.windows[win]) || {}, ci = w.ci || {};
    const sig = w.alpha_annual_pct == null ? "" : (ci.alpha_sig
      ? ' <span class="up" style="font-size:10px">✓显著</span>'
      : ' <span class="muted" style="font-size:10px">≈0</span>');
    return `<tr><td><b>${esc(o.label)}</b></td><td>${c(w.beta)}${ciS(ci.beta)}</td>`
      + `<td ${a(w.alpha_annual_pct)}>${c(w.alpha_annual_pct, "%")}${ciS(ci.alpha)}${sig}</td>`
      + `<td ${a(w.sharpe)}>${c(w.sharpe)}${ciS(ci.sharpe)}</td>`
      + `<td ${a(w.ret_annual_pct)}>${c(w.ret_annual_pct, "%")}</td><td>${c(w.avg_net_gross)}</td><td>${c(w.n)}</td></tr>`;
  }).join("");
  const legCell = (x) => (x && x.ret_annual_pct != null
    ? `<span class="${x.ret_annual_pct >= 0 ? "up" : "down"}">${x.ret_annual_pct}%</span>${ciS(x.ret_ci)} <span class="muted" style="font-size:10px">β${c(x.beta)}·n${c(x.n)}</span>`
    : "—");
  const legRows = order.map((k) => {
    const w = (r.accounts[k].windows && r.accounts[k].windows[win]) || {};
    return `<tr><td><b>${esc(r.accounts[k].label)}</b></td><td>${legCell(w.long)}</td><td>${legCell(w.short)}</td></tr>`;
  }).join("");
  const wlabel = { all: "全部", ytd: "2026 以来", "1y": "近 1 年", "3m": "近 3 月" }[win] || win;
  $("robust-stats").innerHTML =
    `<div class="sc-wrap"><table class="bt-table"><tr><th>账户</th><th>β</th><th>α年化(95%CI)</th><th>Sharpe</th><th>年化收益</th><th>净/毛</th><th>n</th></tr>${trs}</table></div>`
    + `<div class="muted small" style="margin:10px 0 4px"><b>多空腿归因</b> · 年化收益[95%CI]·β·n(空头 β 应为负=真做空;CI 极宽=贡献是噪声)</div>`
    + `<div class="sc-wrap"><table class="bt-table"><tr><th>账户</th><th>多头腿</th><th>空头腿</th></tr>${legRows}</table></div>`
    + `<div class="muted small" style="margin-top:8px">窗口 <b>${wlabel}</b> · 曲线=累计$P&L(M2M 含未实现,仅正股,排除期权/分红,起点归零)。`
    + `<b>α 的 95%CI 跨 0(标 ≈0)= 选股超额与运气不可区分,别当 skill</b>;净/毛≈1=净多头。⚠ 小样本 CI 很宽 = 数据不足,勿过度解读。</div>`;
}

/* 交易复盘:计划(事前登记 thesis+计划价+bundle)→ 归因(平仓后只判流程/守没守计划,不看结果)。
   本机 localStorage(私有),导出 JSON 可给 agent。process>outcome:好交易=守计划,不管盈亏。 */
const PRIV_REPO = "takkujunjieli/stock-dashboard-private";   // 私有库:持仓/复盘/止损等本地数据(换机器 clone 即在)
async function putPrivate(path, obj, msg) {   // PAT PUT 到私有库(PAT 需含私有库写权限);merge sha + 409 重试
  const pat = getPat();
  if (!pat) return { ok: false, msg: "需 PAT(含私有库写权限)" };
  const url = `https://api.github.com/repos/${PRIV_REPO}/contents/${path}`;
  async function once() {
    let sha;
    try { const c = await fetch(url + "?ref=main&t=" + Date.now(), { headers: ghHeaders(pat), cache: "no-store" }); if (c.ok) sha = (await c.json()).sha; } catch { /* 新建 */ }
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(obj, null, 2) + "\n")));
    return fetch(url, { method: "PUT", headers: ghHeaders(pat), body: JSON.stringify({ message: msg, content, sha, branch: "main" }) });
  }
  try { let r = await once(); if (r.status === 409) r = await once(); return r.ok ? { ok: true } : { ok: false, msg: "PUT " + r.status }; }
  catch (e) { return { ok: false, msg: String(e) }; }
}

export async function renderJournal() {   // portfolio.js import 调用(交易复盘挂在 portfolio 页)
  const host = $("journal"); if (!host) return;
  const pol = (await loadJSON("config/risk_policy.json")) || {};
  const bopts = Object.keys(pol.bundles || {}).map((b) => `<option>${esc(b)}</option>`).join("");
  let J = rLS("tradeJournal", null);
  if (!Array.isArray(J)) J = (await loadJSON("data/trade_journal.json")) || [];   // 新机器/浏览器:回落私有库文件
  const closed = J.filter((e) => e.status === "closed"), open = J.filter((e) => e.status !== "closed");
  const foll = closed.filter((e) => e.followed === "是").length;
  const stat = `共 ${J.length} · 持仓中 ${open.length} · 已平 ${closed.length}${closed.length ? ` · 守计划 ${Math.round(foll / closed.length * 100)}%` : ""}`;
  const form = `
    <div class="risk-form" style="margin-bottom:8px">
      <label>标的<input id="j-sym" style="width:78px" placeholder="TSLA"></label>
      <label>方向<select id="j-dir"><option>多</option><option>空</option></select></label>
      <label>Bundle<select id="j-bundle">${bopts}</select></label>
      <label>进场<input id="j-entry" type="number" step="0.01" style="width:84px"></label>
      <label>止损<input id="j-stop" type="number" step="0.01" style="width:84px"></label>
      <label>目标<input id="j-target" type="number" step="0.01" style="width:84px"></label>
      <label>股数<input id="j-size" type="number" style="width:72px"></label>
    </div>
    <div class="risk-form" style="margin-bottom:8px">
      <label style="flex:1;min-width:260px">论点 edge(为什么进)<input id="j-thesis" style="width:100%" placeholder="突破前高 $96 变支撑 + HBM 卡位…"></label>
      <label style="flex:1;min-width:260px">证伪条件(thesis 被推翻=离场,非"亏X%")<input id="j-invalid" style="width:100%" placeholder="跌回 $96 下方 / 指引下调…"></label>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
      <button id="j-add" class="mini-btn">＋记录计划</button>
      <button id="j-push" class="mini-btn">💾 存到私有库(换机器不丢)</button>
      <button id="j-export" class="mini-btn">导出 JSON</button>
      <span id="j-msg" class="muted small">${stat}</span>
    </div>`;
  const plan = (e) => `<b>${esc(e.sym)}</b> <span class="${e.dir === "空" ? "down" : "up"}">${e.dir}</span> · ${esc(e.bundle || "")} · 进 ${e.entry ?? "?"} / 止 ${e.stop ?? "?"} / 标 ${e.target ?? "?"} · ${e.size ?? "?"}股 <span class="muted small">${(e.ts || "").slice(0, 10)}</span><br><span class="muted small">edge: ${esc(e.thesis || "—")} | 证伪: ${esc(e.invalid || "—")}</span>`;
  const openCard = (e) => `<div class="card" style="margin:6px 0" data-id="${e.id}">${plan(e)}
    <div class="risk-form" style="margin-top:6px">
      <label>平仓价<input class="jc-exit" type="number" step="0.01" style="width:84px"></label>
      <label>守计划?<select class="jc-foll"><option>是</option><option>否</option></select></label>
      <label style="flex:1;min-width:220px">归因(用当时信息判决策)<input class="jc-attrib" style="width:100%" placeholder="止损位对/进早了/该减仓…"></label>
      <button class="jc-close mini-btn">平仓归因</button><button class="jc-del mini-btn">删</button>
    </div></div>`;
  const closedCard = (e) => `<div class="card" style="margin:6px 0;opacity:.85" data-id="${e.id}">${plan(e)}
    <div class="muted small" style="margin-top:4px">平仓 ${e.exit ?? "?"} · 守计划 <b class="${e.followed === "是" ? "up" : "down"}">${e.followed || "?"}</b> · 归因: ${esc(e.attrib || "—")} <button class="jc-del mini-btn" style="float:right">删</button></div></div>`;
  host.innerHTML = form
    + (open.length ? `<div class="muted small">持仓中</div>${open.map(openCard).join("")}` : "")
    + (closed.length ? `<div class="muted small" style="margin-top:8px">已平仓</div>${closed.map(closedCard).join("")}` : "");

  const save = (arr) => { rLSset("tradeJournal", arr); renderJournal(); };
  $("j-add").addEventListener("click", () => {
    const sym = ($("j-sym").value || "").trim().toUpperCase(); if (!sym) return;
    const e = { id: Date.now(), ts: new Date().toISOString(), status: "open", sym, dir: $("j-dir").value,
      bundle: $("j-bundle").value, entry: +$("j-entry").value || null, stop: +$("j-stop").value || null,
      target: +$("j-target").value || null, size: +$("j-size").value || null,
      thesis: $("j-thesis").value.trim(), invalid: $("j-invalid").value.trim() };
    save([e, ...J]);
  });
  $("j-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(J, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "trade_journal.json"; a.click();
  });
  $("j-push").addEventListener("click", async () => {
    const m = $("j-msg"); m.textContent = "存到私有库中…";
    const r = await putPrivate("trade_journal.json", rLS("tradeJournal", []), "chore: trade journal via UI");
    m.textContent = r.ok ? "✓ 已存私有库(换机器 clone 即在)" : "✗ " + r.msg;
  });
  host.querySelectorAll(".jc-close").forEach((btn) => btn.addEventListener("click", (ev) => {
    const card = ev.target.closest("[data-id]"), id = +card.dataset.id;
    const arr = J.map((e) => e.id !== id ? e : { ...e, status: "closed", ts_close: new Date().toISOString(),
      exit: +card.querySelector(".jc-exit").value || null, followed: card.querySelector(".jc-foll").value,
      attrib: card.querySelector(".jc-attrib").value.trim() });
    save(arr);
  }));
  host.querySelectorAll(".jc-del").forEach((btn) => btn.addEventListener("click", (ev) => {
    const id = +ev.target.closest("[data-id]").dataset.id; save(J.filter((e) => e.id !== id));
  }));
}

async function main() {
  // 仓位/风控/组合稳健性/交易复盘已迁到 portfolio 页(portfolio.js import 这些函数);此页只留回测。
  const d = await loadFreshJSON("data/strategy_bt.json");
  if (!d || !Array.isArray(d.equity_curve) || !d.equity_curve.length) {
    $("bt-empty").style.display = "block";
    $("bt-empty").textContent = "还没有回测结果 —— 由采集时的 strategy_run 生成(读 gex_daily)。先让样本攒够几天。";
    return;
  }
  $("bt-sub").textContent = `${d.sym} · 信号 ${d.signal} · ${d.n_bars} bars`;
  $("bt-caveat").innerHTML = `<b>⚠️ 研究已验证机制,回测信号为示例</b> · ${esc(d.caveat || "以 OOS 为准。")}`;

  const b = d.benchmark || {};
  $("bt-stats").innerHTML = [
    tile("Trades", d.total_trades ?? 0),
    tile("Win rate", (d.win_rate ?? 0) + "%"),
    tile("Total return", pct(d.total_return_pct), "", upcls(d.total_return_pct)),
    tile("Max DD", "−" + (d.max_drawdown_pct ?? 0) + "%", "", "down"),
    tile("vs Buy&Hold", pct(b.total_return_pct), "基准", upcls(b.total_return_pct)),
    tile("TP / SL", d.take_profit_pct + "% / " + d.stop_loss_pct + "%"),
    tile("Cost / lag", (d.cost_bps ?? 0) + "bp / " + (d.entry_lag ?? 0)),
  ].join("");

  // 风险/收益指标
  const m = d.metrics || {};
  $("bt-metrics").innerHTML = [
    tile("Sharpe", num(m.sharpe), "年化"),
    tile("Sortino", num(m.sortino), "年化"),
    tile("Profit factor", num(m.profit_factor)),
    tile("Payoff", num(m.payoff)),
    tile("Expectancy", num(m.expectancy_pct, 3) + "%", "每笔"),
    tile("Exposure", num((m.exposure ?? 0) * 100, 0) + "%"),
    tile("CAGR", m.cagr_pct == null ? "—" : pct(m.cagr_pct)),
  ].join("");

  // 权益曲线 + 基准叠加
  const chart = LWC.createChart($("bt-chart"), {
    layout: { background: { color: "transparent" }, textColor: "#8b96ad" },
    grid: { vertLines: { color: "#1e2941" }, horzLines: { color: "#1e2941" } },
    rightPriceScale: { borderColor: "#2a3550" },
    timeScale: { borderColor: "#2a3550", timeVisible: true },
    height: 360,
  });
  chart.addLineSeries({ color: "#60a5fa", lineWidth: 2 }).setData(lineData(d.equity_curve));
  if (b.equity_curve?.length) {
    chart.addLineSeries({ color: "#8b96ad", lineWidth: 1, lineStyle: LWC.LineStyle.Dashed }).setData(lineData(b.equity_curve));
  }
  chart.timeScale().fitContent();

  // Walk-forward OOS
  const oos = d.oos;
  if (oos) {
    $("bt-oos").innerHTML =
      `<div class="wb-statbar">${[
        tile("OOS return", pct(oos.oos_total_return_pct), oos.n_folds + " 折", upcls(oos.oos_total_return_pct)),
        tile("OOS win rate", (oos.oos_win_rate ?? 0) + "%"),
        tile("OOS trades", oos.oos_trades ?? 0),
        tile("OOS max DD", "−" + (oos.oos_max_drawdown_pct ?? 0) + "%", "", "down"),
        tile("train / test", oos.train + " / " + oos.test + " bars"),
      ].join("")}</div>`;   // 逐折明细长表已隐藏,只留汇总
  } else {
    $("bt-oos").innerHTML = `<div class="empty">${esc(d.oos_note || "样本不足做 walk-forward;攒够后这里出 OOS 结果(参数在训练窗选、表现在测试窗算)。")}</div>`;
  }

  // 逐笔交易长表已隐藏 —— 整节收起
  const tsec = $("bt-trades") && $("bt-trades").closest("section");
  if (tsec) tsec.style.display = "none";
}
if (document.getElementById("bt-chart")) main();   // 仅策略页自跑;被 portfolio.js import 时不跑
