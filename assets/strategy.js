/* 策略回测页(PR7):读 data/strategy_bt.json,渲染统计 + 指标 + 权益曲线(叠加基准)+ OOS + 交易。只读。 */
import { $, esc, loadJSON, loadFreshJSON, getPat, setPat, ghHeaders, REPO } from "./shared.js";
const LWC = window.LightweightCharts;

/* 账户风险控制 · 仓位计算器 + bundle 管理。读/写 config/risk_policy.json(日后 agentic 读同一份)。
   每个 bundle = 单笔风险% + ATR倍数 + 仓位上限%;止损决定仓位 shares=净值×risk%÷(entry−stop)。 */
async function savePolicy(POLICY) {
  const pat = getPat();
  if (!pat) return { ok: false, msg: "需 fine-grained PAT(与采集面板共用,存本机);未写仓库" };
  const url = `https://api.github.com/repos/${REPO}/contents/config/risk_policy.json`;
  let sha;
  try { const c = await fetch(url + "?ref=main", { headers: ghHeaders(pat) }); if (c.ok) sha = (await c.json()).sha; } catch { /* 新建 */ }
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(POLICY, null, 2) + "\n")));
  try {
    const r = await fetch(url, { method: "PUT", headers: ghHeaders(pat),
      body: JSON.stringify({ message: "chore: update risk_policy via strategy UI", content, sha, branch: "main" }) });
    return r.ok ? { ok: true } : { ok: false, msg: "PUT 失败 " + r.status };
  } catch (e) { return { ok: false, msg: String(e) }; }
}

async function renderRiskControl() {
  const host = $("risk-control"); if (!host) return;
  let POLICY = (await loadJSON("config/risk_policy.json")) || {};
  if (!POLICY.bundles || !Object.keys(POLICY.bundles).length) {
    POLICY = { account_equity: 100000, atr_period: 14, default_bundle: "常规",
      bundles: { "常规": { risk_pct: 0.75, atr_mult: 2.0, max_position_pct: 20 } },
      stop_bases: (POLICY && POLICY.stop_bases) || [] };
  }
  const atrP = POLICY.atr_period ?? 14;
  let cur = (POLICY.default_bundle && POLICY.bundles[POLICY.default_bundle]) ? POLICY.default_bundle : Object.keys(POLICY.bundles)[0];
  const g = (id) => +$(id).value;
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
      <button id="rk-save" class="mini-btn">保存到 config</button>
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

  $("rk-bundle").addEventListener("change", () => { cur = $("rk-bundle").value; loadBundle(); compute(); });
  ["rk-risk", "rk-mult", "rk-cap"].forEach((id) => $(id).addEventListener("input", () => { syncBundle(); compute(); }));
  ["rk-eq", "rk-entry", "rk-stop", "rk-atr"].forEach((id) => $(id).addEventListener("input", compute));
  $("rk-mode").addEventListener("change", compute);
  $("rk-new").addEventListener("click", () => {
    const name = ($("rk-newname").value || "").trim();
    if (!name) return void ($("rk-msg").textContent = "先填 bundle 名");
    if (POLICY.bundles[name]) return void ($("rk-msg").textContent = "同名已存在");
    POLICY.bundles[name] = { risk_pct: 0.75, atr_mult: 2.0, max_position_pct: 20 };
    cur = name; $("rk-bundle").innerHTML = bundleOpts(); $("rk-newname").value = "";
    loadBundle(); compute(); $("rk-msg").textContent = `已建「${name}」(记得保存)`;
  });
  $("rk-del").addEventListener("click", () => {
    if (Object.keys(POLICY.bundles).length <= 1) return void ($("rk-msg").textContent = "至少保留 1 个 bundle");
    delete POLICY.bundles[cur]; cur = Object.keys(POLICY.bundles)[0];
    $("rk-bundle").innerHTML = bundleOpts(); loadBundle(); compute(); $("rk-msg").textContent = "已删除(记得保存)";
  });
  $("rk-save").addEventListener("click", async () => {
    syncBundle(); POLICY.account_equity = g("rk-eq"); POLICY.default_bundle = cur;
    $("rk-msg").textContent = "保存中…";
    const r = await savePolicy(POLICY);
    $("rk-msg").textContent = r.ok ? "✓ 已保存到 config/risk_policy.json(agentic 读同一份)" : "✗ " + r.msg;
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

async function saveAssignments(assign) {   // 分组落进 risk_policy.json(agent 读同一份);先拉最新 merge,保留 bundles
  const latest = (await loadJSON("config/risk_policy.json")) || {};
  latest.assignments = assign;
  return savePolicy(latest);
}

async function renderRiskExposure() {
  const host = $("risk-expo"), heatEl = $("risk-heat"); if (!host) return;
  const [pf, atrJ, P] = await Promise.all([
    loadJSON("data/portfolio.json"), loadJSON("data/atr.json"), loadJSON("config/risk_policy.json")]);
  if (!pf || !Array.isArray(pf.positions) || !pf.positions.length) {
    if (heatEl) heatEl.innerHTML = '<span class="muted small">本地专用:需 data/portfolio.json(gitignored,公开站不显示)。本地刷新持仓后可见。</span>';
    host.innerHTML = ""; return;
  }
  const ATR = (atrJ && atrJ.atr14) || {};
  const bundles = (P && P.bundles) || { "常规": { risk_pct: 0.75, atr_mult: 2.0, max_position_pct: 20 } };
  const bnames = Object.keys(bundles);
  const defB = (P && P.default_bundle && bundles[P.default_bundle]) ? P.default_bundle : bnames[0];
  const maxHeat = (P && P.portfolio && P.portfolio.max_total_heat_pct) || 6;
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
    const isOpt = p.kind !== "equity", long = qty > 0, price = p.price;
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
    rows.push({ sym, isOpt, long, qty, price, cost: p.avg_cost, stop, atr, bundleName, cap: b.max_position_pct || 20,
                openRisk, riskPct, ratio, posPct, distPct, pnlPct: p.pnl_pct != null ? p.pnl_pct * 100 : null });
  }
  rows.sort((a, b) => (b.openRisk || 0) - (a.openRisk || 0));

  const cell = (txt, lvl) => `<td class="sc-num"${lvl == null ? "" : ` style="${heatBg(lvl)}"`}>${txt}</td>`;
  const pnlCell = (v) => { if (v == null) return "<td>—</td>"; const l = Math.min(Math.abs(v) / 40, 1), hue = v >= 0 ? 142 : 0; return `<td class="sc-num" style="background:hsl(${hue} 65% 45% / ${(0.06 + l * 0.34).toFixed(2)})">${v >= 0 ? "+" : ""}${v.toFixed(0)}%</td>`; };
  const grpSel = (r) => `<select class="rk-grp" data-sym="${esc(r.sym)}">${bnames.map((k) => `<option${k === r.bundleName ? " selected" : ""}>${esc(k)}</option>`).join("")}</select>`;
  const stopIn = (r) => `<input class="rk-stopin" data-sym="${esc(r.sym)}" type="number" step="0.01" value="${r.stop != null ? r.stop.toFixed(2) : ""}" placeholder="${r.isOpt ? "期权" : (r.atr != null ? "ATR" : "手填")}" style="width:70px">`;
  const body = rows.map((r) => `<tr>
    <td class="sc-tk"><b>${esc(r.sym)}</b> <span class="sc-dir ${r.long ? "up" : "down"}">${r.isOpt ? "期" : r.long ? "多" : "空"}</span></td>
    <td>${grpSel(r)}</td><td>${r.qty}</td><td>$${r.price != null ? r.price.toFixed(2) : "—"}</td>
    <td class="muted">$${r.cost != null ? r.cost.toFixed(2) : "—"}</td><td>${stopIn(r)}</td>
    ${cell(r.riskPct != null ? r.riskPct.toFixed(2) + "%" : "—", r.riskPct == null ? null : Math.min(r.riskPct / 2, 1))}
    ${cell(r.ratio != null ? r.ratio.toFixed(2) + "×" : "—", r.ratio == null ? null : Math.min(r.ratio / 1.5, 1))}
    ${cell(r.posPct.toFixed(1) + "%", Math.min(r.posPct / r.cap, 1))}
    ${cell(r.distPct != null ? r.distPct.toFixed(1) + "%" : "—", r.distPct == null ? null : Math.max(0, Math.min(1, 1 - r.distPct / 15)))}
    ${pnlCell(r.pnlPct)}</tr>`).join("");

  host.innerHTML = `<div class="sc-wrap"><table class="sc-table">
    <tr><th>标的</th><th>组</th><th>股数</th><th>现价</th><th>成本</th><th>止损</th>
        <th>在险%</th><th>在险/预算</th><th>仓位%</th><th>距止损%</th><th>浮盈%</th></tr>${body}</table></div>
    <div class="muted small" style="margin-top:8px">在险%=|股数|×|现价−止损|÷净值 · 在险/预算=该仓在险÷所属 bundle 单笔预算(>1 超险)· 仓位%对比 bundle 上限 · 距止损%小=逼近止损 · 浮盈%仅参考(现价口径,成本不进风险)。止损默认 ATR 法,可每仓手填覆盖(存本机)。</div>`;

  const totalPct = totalHeat / equity * 100;
  heatEl.innerHTML = `<div class="wb-statbar">
    <div class="opt-tile"><div class="opt-k">账户</div><div class="opt-v"><select id="rk-acct" style="background:var(--card-hover);border:1px solid var(--border);border-radius:6px;padding:3px 6px;color:var(--text);font-size:13px">${["ALL", ...accounts.map((a) => a.id)].map((id) => `<option value="${esc(id)}"${id === acctSel ? " selected" : ""}>${esc(id === "ALL" ? "全部" : (accounts.find((a) => a.id === id) || {}).label || id)}</option>`).join("")}</select></div></div>
    <div class="opt-tile"><div class="opt-k">账户净值(portfolio)</div><div class="opt-v">$${Math.round(equity).toLocaleString()}</div><div class="opt-sub">${eqSrc}</div></div>
    <div class="opt-tile"><div class="opt-k">组合总在险 heat</div><div class="opt-v" style="${heatBg(Math.min(totalPct / maxHeat, 1))};border-radius:6px;padding:1px 8px">$${Math.round(totalHeat).toLocaleString()} · ${totalPct.toFixed(2)}%</div><div class="opt-sub">上限 ${maxHeat}% 净值</div></div>
    ${bnames.filter((k) => heatByBundle[k]).map((k) => `<div class="opt-tile"><div class="opt-k">${esc(k)} 在险</div><div class="opt-v">$${Math.round(heatByBundle[k]).toLocaleString()} · ${(heatByBundle[k] / equity * 100).toFixed(2)}%</div></div>`).join("")}</div>
    <div class="muted small" style="margin-top:6px">组合总在险 = 所有持仓在险之和(若止损全被打的总亏损)。${totalPct > maxHeat ? `<span class="down">⚠️ 超总上限 ${maxHeat}%,考虑减仓/收紧止损</span>` : "在上限内。"}</div>
    <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">
      <button id="rk-savegrp" class="mini-btn">💾 发布分组到 config(供 agent 读)</button>
      <input id="rk-pat" type="password" value="${esc(getPat() || "")}" placeholder="fine-grained PAT(本机存)" style="width:200px;background:var(--card-hover);border:1px solid var(--border);border-radius:6px;padding:5px 8px;color:var(--text);font-size:12px">
      <span id="rk-grpmsg" class="muted small">分组改动已本地自动保存(localStorage);发布到 config 才让 agent/别的机器读到(需 PAT)</span>
    </div>`;

  host.querySelectorAll(".rk-grp").forEach((el) => el.addEventListener("change", () => { ASSIGN[el.dataset.sym] = el.value; const g = rLS("riskGroups", {}); g[el.dataset.sym] = el.value; rLSset("riskGroups", g); renderRiskExposure(); }));
  host.querySelectorAll(".rk-stopin").forEach((el) => el.addEventListener("change", () => { const s = rLS("riskStops", {}), v = el.value.trim(); if (v === "") delete s[el.dataset.sym]; else s[el.dataset.sym] = +v; rLSset("riskStops", s); renderRiskExposure(); }));
  const ac = $("rk-acct"); if (ac) ac.addEventListener("change", () => { rLSset("riskAccount", ac.value); renderRiskExposure(); });
  const pt = $("rk-pat"); if (pt) pt.addEventListener("change", () => { setPat(pt.value.trim()); $("rk-grpmsg").textContent = pt.value.trim() ? "✓ PAT 已存本机,可发布了" : "PAT 已清"; });
  const sg = $("rk-savegrp"); if (sg) sg.addEventListener("click", async () => { const m = $("rk-grpmsg"); m.textContent = "发布中…"; const r = await saveAssignments(ASSIGN); m.textContent = r.ok ? "✓ 已发布到 config/risk_policy.json 的 assignments(agent 读同一份)" : "✗ " + r.msg; });
}

async function main() {
  // 5Y 走势聚合 与 净 GEX→次日波动 研究 已迁移到 research 页(收益率×市场 / GEX→波动 两个 tab)
  await renderRiskControl();     // 账户风险控制:独立于回测数据,始终显示
  await renderRiskExposure();    // 风险敞口热力图:本地专用(读 portfolio.json)
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
main();
