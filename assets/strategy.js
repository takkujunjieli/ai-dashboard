/* 策略回测页(PR7):读 data/strategy_bt.json,渲染统计 + 指标 + 权益曲线(叠加基准)+ OOS + 交易。只读。 */
import { $, esc, loadJSON, loadFreshJSON, getPat, setPat, ghHeaders, REPO } from "./shared.js";
const LWC = window.LightweightCharts;

/* 账户风险控制 · 仓位计算器 + thesis 管理(UI 称 Thesis;历史数据键沿用 bundles/default_bundle
   以兼容已存 config/localStorage)。读/写 config/risk_policy.json(日后 agentic 读同一份)。
   每个 thesis = 单笔风险% + ATR倍数 + 仓位上限%;止损决定仓位 shares=净值×risk%÷(entry−stop)。 */
// 两个入口(theses / assignments)都写同一个 risk_policy.json。为避免互相覆盖 + sha 冲突(409):
// 每次都先拉「最新内容+sha」,只改自己那块(mutate),再 PUT;409(sha 过期)自动重取重试一次。
async function putPolicy(mutate) {
  const pat = getPat();
  if (!pat) return { ok: false, msg: "需 fine-grained PAT(与采集面板共用,存本机);未写仓库" };
  const url = `https://api.github.com/repos/${PRIV_REPO}/contents/risk_policy.json`;   // 私有库(本地专用,公开站不含)
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
    const hint = r.status === 404 ? "(PAT 无 stock-dashboard-private 写权限?)" : r.status === 401 ? "(PAT 无效/过期)" : r.status === 403 ? "(PAT 权限不足/限流)" : "";
    return r.ok ? { ok: true } : { ok: false, msg: "PUT " + r.status + " " + hint };
  } catch (e) { return { ok: false, msg: String(e) }; }
}

/* 风险策略自动同步(hybrid):任何改动先落本机 localStorage(即时、免 PAT、离线不丢),
   再 debounce 把整份 policy(theses + assignments + max-heat + equity)提交到私有库。
   thesis 管理 + 风险敞口 两面板共用;状态显示在 #rk-sync。 */
let rpSyncTimer = null;
function rpStatus(txt, cls = "muted", title = "") { const el = document.getElementById("rk-sync"); if (el) el.innerHTML = `<span class="${cls}"${title ? ` title="${esc(title)}"` : ""}>${txt}</span>`; }
async function rpSyncNow() {
  clearTimeout(rpSyncTimer);
  if (!getPat()) { rpStatus("⚠ 未设 PAT · 点此设置", "down"); return; }
  rpStatus("syncing…");
  const LP = rLS("riskPolicy", {}), groups = rLS("riskGroups", {}), mh = rLS("riskMaxHeat", null);
  const r = await putPolicy((L) => {
    if (LP.bundles) L.bundles = LP.bundles;
    if (LP.default_bundle) L.default_bundle = LP.default_bundle;
    if (LP.account_equity != null) L.account_equity = LP.account_equity;
    L.assignments = ASSIGN ? { ...ASSIGN } : { ...(L.assignments || {}), ...groups };
    if (mh != null && !Number.isNaN(+mh)) L.portfolio = { ...(L.portfolio || {}), max_total_heat_pct: +mh };
  });
  rpStatus(r.ok ? `✓ synced ${new Date().toTimeString().slice(0, 5)}` : `✗ 同步失败 · 点重试`, r.ok ? "muted" : "down", r.ok ? "" : (r.msg || ""));
}
function rpSchedule(now = false) {   // 改动即调度:now=结构性动作/失焦立刻,否则 2.5s debounce
  clearTimeout(rpSyncTimer);
  if (!getPat()) { rpStatus("⚠ 未设 PAT · 点此设置", "down"); return; }
  rpStatus("• 待同步…");
  if (now) rpSyncNow(); else rpSyncTimer = setTimeout(rpSyncNow, 2500);
}
async function rpSyncCompleted() { if (getPat()) await putPrivate("completed_theses.json", rLS("completedTheses", []), "chore: completed theses via UI"); }

export async function renderRiskControl() {
  const host = $("risk-control"); if (!host) return;
  let POLICY = (await loadJSON("config/risk_policy.json")) || {};
  if (!POLICY.bundles || !Object.keys(POLICY.bundles).length) {
    POLICY = { account_equity: 100000, atr_period: 14, default_bundle: "常规",
      bundles: { "常规": { risk_pct: 0.75, atr_mult: 2.0, max_position_pct: 20 } },
      stop_bases: (POLICY && POLICY.stop_bases) || [] };
  }
  // 本机 localStorage 覆盖(thesis 编辑即时本地持久化,免 PAT;刷新不丢);"保存到 config" 再发布给 agent
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

  const gt = (id) => { const v = $(id).value; return v === "" ? null : +v; };  // 数值,空→null
  host.innerHTML = `
    <div class="risk-bundles">
      <label>Thesis<span id="rk-sel-wrap"><select id="rk-bundle">${bundleOpts()}</select></span></label>
      <input id="rk-newname" type="text" placeholder="新 thesis 名" style="width:130px">
      <button id="rk-new" class="mini-btn">＋ 新建</button>
      <span class="rk-menu-wrap"><button id="rk-menu-btn" class="mini-btn" title="当前 thesis 操作:重命名 / 完成 / 删除">⋯</button>
        <div id="rk-menu" class="rk-menu" hidden>
          <button class="rk-menu-item" data-act="rename">✏️ 重命名</button>
          <button class="rk-menu-item" data-act="complete">✅ 完成并归档</button>
          <button class="rk-menu-item rk-danger" data-act="delete">🗑 删除</button>
        </div></span>
      <input id="rk-pat" type="password" value="${esc(getPat() || "")}" placeholder="粘贴 fine-grained PAT(含私有库写权限)" hidden style="width:230px;background:var(--card-hover);border:1px solid var(--border);border-radius:6px;padding:5px 8px;color:var(--text);font-size:12px">
      <span id="rk-sync" class="muted small" style="margin-left:auto;cursor:pointer" title="点击:未设 PAT→设置;失败→重试">同步就绪</span>
      <span id="rk-msg" class="muted small"></span>
    </div>
    <div class="risk-form" style="margin-top:10px">
      <label>单笔风险 %<input id="rk-risk" type="number" step="0.05" style="width:88px" placeholder="optional" title="单笔止损被打的亏损占净值%,决定仓位股数(留空默认 0.75)"></label>
      <label>单笔仓位上限 %<input id="rk-cap" type="number" step="1" style="width:96px" placeholder="optional" title="单个持仓市值上限(占净值%;留空默认 20)"></label>
      <label>总风险 %<input id="rk-totrisk" type="number" step="0.5" style="width:88px" placeholder="optional" title="该 thesis 所有持仓在险之和上限(占净值%);热力图按此判超险"></label>
      <label>总仓位上限 %<input id="rk-totcap" type="number" step="1" style="width:96px" placeholder="optional" title="该 thesis 所有持仓市值之和上限(占净值%);热力图按此判超险"></label>
      <label>ATR 倍数<input id="rk-mult" type="number" step="0.1" style="width:76px" placeholder="optional" title="留空默认 2.0"></label>
      <label>Target Profit %<input id="rk-goal" type="number" step="1" style="width:96px" placeholder="optional"></label>
      <label>Shelf life<input id="rk-shelf" type="date" style="width:150px" title="thesis 有效期(可选);过期未走出=复盘/离场"></label>
    </div>
    <div class="risk-form" style="margin-top:6px">
      <label style="flex:1;min-width:260px">Edge (optional)<input id="rk-edge" style="width:100%" placeholder="为什么这个 thesis 成立…"></label>
      <label style="flex:1;min-width:260px">Invalidation (optional)<input id="rk-invalid" style="width:100%" placeholder="什么情况证明 thesis 被推翻=离场,非亏X%…"></label>
    </div>
    <div class="risk-form" style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px">
      <label>账户净值 $<input id="rk-eq" type="number" step="1000" value="${POLICY.account_equity ?? 100000}"></label>
      <label>买入价 $<input id="rk-entry" type="number" step="0.01" value="100"></label>
      <label>止损法<select id="rk-mode"><option value="manual">手动止损价</option><option value="atr">ATR 法</option></select></label>
      <label id="rk-stop-wrap">止损价 $<input id="rk-stop" type="number" step="0.01" value="94"></label>
      <label id="rk-atr-wrap" style="display:none">ATR${atrP} $<input id="rk-atr" type="number" step="0.01" value="3"></label>
    </div>
    <div id="rk-out" class="wb-statbar" style="margin-top:12px"></div>
    <div id="rk-note" class="muted small" style="margin-top:6px"></div>
    <div id="rk-done" class="muted small" style="margin-top:10px"></div>
    <div class="muted small" style="margin-top:10px"><b>止损放在 thesis 被证伪处</b>(不是"亏 X% 就卖"):${(POLICY.stop_bases || []).map(esc).join(" · ")}。<br>核心:<b>止损位决定仓位</b>;每个 thesis 自带 单笔风险%/单笔仓位上限%/总风险%/总仓位上限%/ATR倍数/Target Profit/Shelf life/Edge/Invalidation(均可选,留空 = 不约束/用默认)。改字段即自动同步到私有库(见右上状态),无需手动保存。ATR 法:止损=买入−倍数×ATR${atrP}。</div>`;

  const loadBundle = () => { const b = POLICY.bundles[cur] || {};   // 全 optional:null → 空白(不再显默认值)
    $("rk-risk").value = b.risk_pct ?? ""; $("rk-mult").value = b.atr_mult ?? ""; $("rk-cap").value = b.max_position_pct ?? "";
    $("rk-totrisk").value = b.total_risk_pct ?? ""; $("rk-totcap").value = b.total_position_pct ?? ""; $("rk-goal").value = b.target_profit_pct ?? "";
    $("rk-shelf").value = b.shelf || ""; $("rk-edge").value = b.edge || ""; $("rk-invalid").value = b.invalid || ""; };
  const syncBundle = () => { const b = POLICY.bundles[cur] || (POLICY.bundles[cur] = {});
    b.risk_pct = gt("rk-risk"); b.atr_mult = gt("rk-mult"); b.max_position_pct = gt("rk-cap");
    b.total_risk_pct = gt("rk-totrisk"); b.total_position_pct = gt("rk-totcap"); b.target_profit_pct = gt("rk-goal");
    b.shelf = $("rk-shelf").value || null; b.edge = $("rk-edge").value.trim(); b.invalid = $("rk-invalid").value.trim(); };

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

  const DONE = "completedTheses";   // 已完成 thesis 存档(本机;可发布到私有库)
  const renderDone = () => { const done = rLS(DONE, []);
    $("rk-done").innerHTML = done.length
      ? `<b>已完成 ${done.length}</b>(存档,不计入活跃):` + done.map((d) => `<span class="sc-dir muted" style="margin:2px 3px;display:inline-block">${esc(d.name)}${d.target_profit_pct != null ? ` · Target ${d.target_profit_pct}%` : ""} <span class="muted">${(d.completed_at || "").slice(0, 10)}</span></span>`).join("")
      : ""; };

  const rebuildSel = () => { $("rk-sel-wrap").innerHTML = `<select id="rk-bundle">${bundleOpts()}</select>`; };
  // ---- 字段编辑:落本机 + 调度自动同步(input 防抖);热力图在 change(失焦/回车)时刷新 ----
  const onEdit = (recompute) => () => { syncBundle(); if (recompute) compute(); persistLocal(); rpSchedule(); };
  ["rk-risk", "rk-mult", "rk-cap"].forEach((id) => { const el = $(id); el.addEventListener("input", onEdit(true)); el.addEventListener("change", () => { renderRiskExposure(); rpSchedule(true); }); });
  ["rk-totrisk", "rk-totcap", "rk-goal"].forEach((id) => { const el = $(id); el.addEventListener("input", onEdit(false)); el.addEventListener("change", () => { renderRiskExposure(); rpSchedule(true); }); });
  ["rk-shelf", "rk-edge", "rk-invalid"].forEach((id) => { const el = $(id); el.addEventListener("input", onEdit(false)); el.addEventListener("change", () => rpSchedule(true)); });
  ["rk-eq", "rk-entry", "rk-stop", "rk-atr"].forEach((id) => $(id).addEventListener("input", compute));
  $("rk-eq").addEventListener("input", () => { persistLocal(); rpSchedule(); });
  $("rk-eq").addEventListener("change", () => rpSchedule(true));
  $("rk-mode").addEventListener("change", compute);
  // ---- thesis 选择(委托,重建 select 后仍有效)+ 内联重命名 ----
  const startRename = () => { $("rk-sel-wrap").innerHTML = `<input id="rk-ren" value="${esc(cur)}" style="width:150px"><button id="rk-ren-ok" class="mini-btn">✓</button><button id="rk-ren-x" class="mini-btn">✕</button>`; const inp = $("rk-ren"); inp.focus(); inp.select(); };
  const applyRename = () => {
    const name = ($("rk-ren") ? $("rk-ren").value : "").trim();
    if (!name || name === cur) return void rebuildSel();
    if (POLICY.bundles[name]) return void ($("rk-msg").textContent = "同名已存在");
    const old = cur;
    const nb = {}; for (const [k, v] of Object.entries(POLICY.bundles)) nb[k === old ? name : k] = v;  // 保序换键
    POLICY.bundles = nb;
    if (POLICY.default_bundle === old) POLICY.default_bundle = name;
    cur = name;
    if (ASSIGN) for (const s of Object.keys(ASSIGN)) if (ASSIGN[s] === old) ASSIGN[s] = name;   // 内存分组跟随
    const rg = rLS("riskGroups", {}); let ch = false;
    for (const s of Object.keys(rg)) if (rg[s] === old) { rg[s] = name; ch = true; }             // 本机分组跟随
    if (ch) rLSset("riskGroups", rg);
    rebuildSel(); loadBundle(); compute(); persistLocal(); renderRiskExposure(); rpSchedule(true);
    $("rk-msg").textContent = `已重命名「${old}」→「${name}」`;
  };
  $("rk-sel-wrap").addEventListener("change", (e) => { if (e.target.id === "rk-bundle") { cur = e.target.value; loadBundle(); compute(); persistLocal(); renderRiskExposure(); rpSchedule(true); } });
  $("rk-sel-wrap").addEventListener("click", (e) => { if (e.target.id === "rk-ren-ok") applyRename(); else if (e.target.id === "rk-ren-x") rebuildSel(); });
  $("rk-sel-wrap").addEventListener("keydown", (e) => { if (e.target.id === "rk-ren") { if (e.key === "Enter") applyRename(); else if (e.key === "Escape") rebuildSel(); } });
  // ---- 新建 ----
  $("rk-new").addEventListener("click", () => {
    const name = ($("rk-newname").value || "").trim();
    if (!name) return void ($("rk-msg").textContent = "先填 thesis 名");
    if (POLICY.bundles[name]) return void ($("rk-msg").textContent = "同名已存在");
    POLICY.bundles[name] = { risk_pct: 0.75, atr_mult: 2.0, max_position_pct: 20, total_risk_pct: null, total_position_pct: null, target_profit_pct: null, shelf: null, edge: "", invalid: "" };
    cur = name; rebuildSel(); $("rk-newname").value = "";
    loadBundle(); compute(); persistLocal(); rpSchedule(true); $("rk-msg").textContent = `已建「${name}」`;
  });
  // ---- ⋯ 菜单:重命名 / 完成(单确认)/ 删除(两步红色 arm)----
  const menu = $("rk-menu");
  const resetMenu = () => { const c = menu.querySelector('[data-act="complete"]'), d = menu.querySelector('[data-act="delete"]'); if (c) { c.textContent = "✅ 完成并归档"; c.classList.remove("rk-armed"); } if (d) { d.textContent = "🗑 删除"; d.classList.remove("rk-armed"); } };
  const closeMenu = () => { menu.hidden = true; resetMenu(); };
  const doDelete = () => {
    if (Object.keys(POLICY.bundles).length <= 1) return void ($("rk-msg").textContent = "至少保留 1 个 thesis");
    delete POLICY.bundles[cur]; cur = Object.keys(POLICY.bundles)[0];
    rebuildSel(); loadBundle(); compute(); persistLocal(); renderRiskExposure(); rpSchedule(true); $("rk-msg").textContent = "🗑 已删除";
  };
  const doComplete = () => {
    if (Object.keys(POLICY.bundles).length <= 1) return void ($("rk-msg").textContent = "至少保留 1 个活跃 thesis");
    syncBundle();
    const name = cur, done = rLS(DONE, []);
    done.unshift({ name, ...POLICY.bundles[cur], completed_at: new Date().toISOString() });
    rLSset(DONE, done);
    delete POLICY.bundles[cur]; cur = Object.keys(POLICY.bundles)[0];
    rebuildSel(); loadBundle(); compute(); persistLocal(); renderDone(); renderRiskExposure();
    rpSchedule(true); rpSyncCompleted();   // 活跃列表 + 已完成存档 都同步私有库
    $("rk-msg").textContent = `✅ 已完成「${name}」并归档`;
  };
  $("rk-menu-btn").addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; if (menu.hidden) resetMenu(); });
  menu.addEventListener("click", (e) => {
    const btn = e.target.closest(".rk-menu-item"); if (!btn) return;
    const act = btn.dataset.act;
    if (act === "rename") { closeMenu(); startRename(); return; }
    if (!btn.classList.contains("rk-armed")) {   // 第一次点 = 武装确认(4s 自动解除)
      resetMenu(); btn.classList.add("rk-armed");
      btn.textContent = act === "delete" ? `确认删除「${cur}」?` : `确认完成「${cur}」?`;
      setTimeout(() => { if (btn.classList.contains("rk-armed")) resetMenu(); }, 4000);
      return;
    }
    closeMenu(); act === "delete" ? doDelete() : doComplete();
  });
  document.addEventListener("click", (e) => { if (!menu.hidden && !e.target.closest(".rk-menu-wrap")) closeMenu(); });
  // ---- 同步状态 / PAT ----
  $("rk-sync").addEventListener("click", () => { if (!getPat()) { const p = $("rk-pat"); p.hidden = false; p.focus(); } else rpSyncNow(); });
  $("rk-pat").addEventListener("change", () => { const v = $("rk-pat").value.trim(); setPat(v); $("rk-pat").hidden = true; if (v) rpSchedule(true); else rpStatus("⚠ 未设 PAT · 点此设置", "down"); });

  loadBundle(); compute(); renderDone();
  rpStatus(getPat() ? "✓ 就绪 · 改动自动同步" : "⚠ 未设 PAT · 点此设置", getPat() ? "muted" : "down");
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

/* 风险敞口热力图(本地专用)。读 data/portfolio.json + data/atr.json + risk_policy 的 thesis。
   现价口径:open risk=|股数|×|现价−止损|;止损=ATR法(现价∓thesis.ATR倍数×ATR14),可每仓手填覆盖。
   多列绿→红:在险% / 在险÷预算 / 仓位%vs上限 / 距止损% / 浮盈%。+ 组合总在险 heat + 分 thesis 小计。
   分组/止损/净值 存本机 localStorage(不上仓库,honors 隐私)。 */
const rLS = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const rLSset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const heatBg = (lvl) => { const l = Math.max(0, Math.min(1, lvl || 0)); return `background:hsl(${Math.round(142 * (1 - l))} 65% 45% / ${(0.08 + l * 0.42).toFixed(2)})`; };
let ASSIGN = null;   // {sym: thesis} 内存态(含未保存改动),来源 risk_policy.json 的 assignments
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
  const LP = rLS("riskPolicy", {});   // thesis 编辑器的本机即时态,优先于 config 文件,让改动立刻反映到热力表
  const bundles = LP.bundles || (P && P.bundles) || { "常规": { risk_pct: 0.75, atr_mult: 2.0, max_position_pct: 20 } };
  const bnames = Object.keys(bundles);
  const dfb = LP.default_bundle || (P && P.default_bundle);
  const defB = (dfb && bundles[dfb]) ? dfb : bnames[0];
  if (MAXHEAT === null) MAXHEAT = +rLS("riskMaxHeat", (P && P.portfolio && P.portfolio.max_total_heat_pct) ?? 6);
  const maxHeat = MAXHEAT;
  if (ASSIGN === null) ASSIGN = { ...((P && P.assignments) || {}), ...rLS("riskGroups", {}) };  // 本机 localStorage 覆盖(本地即时持久化,无需 PAT);「发布到 config」再推给 agent
  const stops = rLS("riskStops", {});
  const targets = rLS("riskTargets", {});   // 每仓止盈目标价(本机,可空)
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

  // 每 thesis 总仓位($):总仓位上限判超险 + 「距目标」都要用,须在主循环前算全(否则循环内只累加到当前仓)
  const posByBundle = {};
  for (const p of positions) { if (!(p.qty || 0)) continue; const bn = ASSIGN[p.sym] || defB; posByBundle[bn] = (posByBundle[bn] || 0) + Math.abs(p.mkt_value || 0); }
  const rows = []; let totalHeat = 0; const heatByBundle = {};
  for (const p of positions) {
    const sym = p.sym, qty = p.qty || 0; if (!qty) continue;
    const isOpt = p.kind !== "equity", long = qty > 0;
    if (!isOpt && Math.abs(qty) <= 1) continue;   // 去掉 |持股|<=1 的正股(±1 股噪声);期权不受此限(1 张=100 股敞口)
    // 现价:默认用 portfolio.json(MCP 刷新价),不自动同步 K线快照;须手动点「同步现价(K线)」才用 PRICE_OVERRIDE
    const price = (!isOpt && PRICE_OVERRIDE && PRICE_OVERRIDE[sym] != null) ? PRICE_OVERRIDE[sym] : p.price;
    const bundleName = ASSIGN[sym] || defB, b = bundles[bundleName] || bundles[defB];
    const budget = equity * (b.risk_pct || 0.75) / 100, atr = ATR[sym];
    const mult = b.atr_mult || 2;   // optional:留空用默认 2×
    let stop = stops[sym] != null ? +stops[sym]
             : (atr != null && price != null ? (long ? price - mult * atr : price + mult * atr) : null);
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
    // 到风控目标的股数调整:目标 |qty| = min(在险=预算 → budget/每股风险, 仓位=上限 → 净值×上限%/现价);
    // toTarget = 目标|qty| − 当前|qty|:>0 还可加(买/空),<0 需减(卖/补)。期权按张(100股)不适用,置空。
    let toTarget = null;
    if (!isOpt && price > 0) {
      const capQ = equity * (b.max_position_pct || 20) / 100 / price;                             // 单笔仓位上限 → 股
      const capTotQ = b.total_position_pct != null                                                 // 总仓位上限:扣掉同 thesis 其余仓后,给本仓留的空间
        ? (equity * b.total_position_pct / 100 - (posByBundle[bundleName] - Math.abs(p.mkt_value || 0))) / price
        : Infinity;                                                                                // 未设总上限 → 不约束
      const riskQ = (perShare != null && perShare > 0) ? budget / perShare : Infinity;             // 止损锁利(perShare<=0)则风险不约束,只看上限
      toTarget = Math.min(riskQ, capQ, capTotQ) - Math.abs(qty);   // 取最紧:风险预算 / 单笔上限 / 总仓位上限
    }
    rows.push({ sym, isOpt, long, qty, price, cost: p.avg_cost, stop, atr, bundleName, cap: b.max_position_pct || 20,
                tpp: b.target_profit_pct, openRisk, riskPct, ratio, posPct, distPct, pnlPct, toTarget });
  }
  const sorted = sortRows(rows);
  const disp = [...sorted.filter((r) => !r.isOpt), ...sorted.filter((r) => r.isOpt)];   // 期权统一排到最下方(各组内仍按当前排序)

  const cell = (txt, lvl) => `<td class="sc-num"${lvl == null ? "" : ` style="${heatBg(lvl)}"`}>${txt}</td>`;
  const pnlCell = (v) => { if (v == null) return "<td>—</td>"; const l = Math.min(Math.abs(v) / 40, 1), hue = v >= 0 ? 142 : 0; return `<td class="sc-num" style="background:hsl(${hue} 65% 45% / ${(0.06 + l * 0.34).toFixed(2)})">${v >= 0 ? "+" : ""}${v.toFixed(0)}%</td>`; };
  const grpSel = (r) => `<select class="rk-grp" data-sym="${esc(r.sym)}">${bnames.map((k) => `<option${k === r.bundleName ? " selected" : ""}>${esc(k)}</option>`).join("")}</select>`;
  const stopIn = (r) => `<input class="rk-stopin" data-sym="${esc(r.sym)}" type="number" step="0.01" value="${r.stop != null ? r.stop.toFixed(2) : ""}" placeholder="${r.isOpt ? "期权" : (r.atr != null ? "ATR" : "手填")}" style="width:70px">`;
  // 止盈价:手填(riskTargets)覆盖优先;否则所属 thesis 填了 Target Profit% → 按成本×(1±%)自动预填(多加空减,灰色可覆盖)
  const autoTp = (r) => {
    if (targets[r.sym] != null) return { v: +targets[r.sym], auto: false };
    if (r.tpp != null && r.tpp !== "" && r.cost != null)
      return { v: +(r.cost * (r.long ? 1 + r.tpp / 100 : 1 - r.tpp / 100)).toFixed(2), auto: true };
    return { v: null, auto: false };
  };
  const tpIn = (r) => { const t = autoTp(r);
    return `<input class="rk-tpin" data-sym="${esc(r.sym)}" type="number" step="0.01" value="${t.v != null ? t.v : ""}"${t.auto ? ` data-auto="1" title="来自 thesis「${esc(r.bundleName)}」Target Profit ${r.tpp}%,按成本自动算,可手填覆盖"` : ""} placeholder="止盈价" style="width:70px${t.auto ? ";color:#8b96ad" : ""}">`; };
  const tgtCell = (r) => {   // 距风控目标的股数:卖/补=需减仓,可买/可空=还有空间
    if (r.toTarget == null || !isFinite(r.toTarget)) return "<td>—</td>";
    const n = Math.round(r.toTarget);
    if (n === 0) return `<td class="sc-num" title="已在目标仓位">✓</td>`;
    const reduce = n < 0, act = reduce ? (r.long ? "卖" : "补") : (r.long ? "可买" : "可空");
    return `<td class="sc-num ${reduce ? "down" : "up"}" title="到风控目标(在险=thesis预算且≤仓位上限)需${act} ${Math.abs(n)} 股">${act} ${Math.abs(n)}</td>`;
  };
  const arrow = (k) => SORT.key === k ? (SORT.dir < 0 ? " ↓" : " ↑") : "";
  const sth = (k, label) => `<th class="rk-sort" data-k="${k}" style="cursor:pointer;user-select:none;white-space:nowrap">${label}${arrow(k)}</th>`;
  const body = disp.map((r) => `<tr>
    <td class="sc-tk"><b>${esc(r.sym)}</b> <span class="sc-dir ${r.long ? "up" : "down"}">${r.isOpt ? "期" : r.long ? "多" : "空"}</span></td>
    <td>${grpSel(r)}</td><td>${r.qty}</td><td>$${r.price != null ? r.price.toFixed(2) : "—"}</td>
    <td class="muted">$${r.cost != null ? r.cost.toFixed(2) : "—"}</td><td>${stopIn(r)}</td><td>${tpIn(r)}</td>
    ${cell(r.riskPct != null ? r.riskPct.toFixed(2) + "%" : "—", r.riskPct == null ? null : Math.min(r.riskPct / 2, 1))}
    ${cell(r.ratio != null ? r.ratio.toFixed(2) + "×" : "—", r.ratio == null ? null : Math.min(r.ratio / 1.5, 1))}
    ${tgtCell(r)}
    ${cell(r.posPct.toFixed(1) + "%", Math.min(r.posPct / r.cap, 1))}
    ${cell(r.distPct != null ? r.distPct.toFixed(1) + "%" : "—", r.distPct == null ? null : Math.max(0, Math.min(1, 1 - r.distPct / 15)))}
    ${pnlCell(r.pnlPct)}</tr>`).join("");

  host.innerHTML = `<div class="sc-wrap"><table class="sc-table">
    <tr>${sth("sym", "标的")}${sth("bundleName", "Thesis")}<th>股数</th><th>现价</th><th>成本</th><th>止损</th><th>止盈</th>
        ${sth("riskPct", "在险%")}${sth("ratio", "在险/预算")}${sth("toTarget", "距目标")}${sth("posPct", "仓位%")}${sth("distPct", "距止损%")}${sth("pnlPct", "浮盈%")}</tr>${body}</table></div>
    <div class="muted small" style="margin-top:8px">在险%=|股数|×|现价−止损|÷净值 · 在险/预算=该仓在险÷所属 thesis 单笔预算(>1 超险)· <b>距目标</b>=到风控目标(取最紧:在险=单笔预算 / ≤单笔仓位上限 / ≤总仓位上限)还需<span class="down">卖/补</span>或<span class="up">可买/可空</span>多少股 · 仓位%对比 thesis 上限 · 距止损%小=逼近止损 · 浮盈%仅参考(现价口径,成本不进风险)。止损默认 ATR 法,可每仓手填覆盖(存本机)。<b>止盈</b>:thesis 填了 Target Profit% 的,按成本×(1±%)自动预填(多加空减,灰色),可每仓手填覆盖;留空=无止盈。</div>`;

  const totalPct = totalHeat / equity * 100;
  heatEl.innerHTML = `<div class="wb-statbar">
    <div class="opt-tile"><div class="opt-k">账户</div><div class="opt-v"><select id="rk-acct" style="background:var(--card-hover);border:1px solid var(--border);border-radius:6px;padding:3px 6px;color:var(--text);font-size:13px">${["ALL", ...accounts.map((a) => a.id)].map((id) => `<option value="${esc(id)}"${id === acctSel ? " selected" : ""}>${esc(id === "ALL" ? "全部" : (accounts.find((a) => a.id === id) || {}).label || id)}</option>`).join("")}</select></div></div>
    <div class="opt-tile"><div class="opt-k">账户净值(portfolio)</div><div class="opt-v">$${Math.round(equity).toLocaleString()}</div><div class="opt-sub">${eqSrc}</div></div>
    <div class="opt-tile"><div class="opt-k">组合总在险 heat</div><div class="opt-v" style="${heatBg(Math.min(totalPct / maxHeat, 1))};border-radius:6px;padding:1px 8px">$${Math.round(totalHeat).toLocaleString()} · ${totalPct.toFixed(2)}%</div><div class="opt-sub">上限 <input id="rk-maxheat" type="number" step="0.5" value="${maxHeat}" style="width:52px;background:var(--card-hover);border:1px solid var(--border);border-radius:5px;padding:1px 5px;color:var(--text);font-size:12px"> % 净值</div></div>
    ${bnames.filter((k) => heatByBundle[k] || posByBundle[k]).map((k) => {
      const b = bundles[k] || {};
      const usedR = (heatByBundle[k] || 0) / equity * 100, capR = b.total_risk_pct, overR = capR != null && usedR > capR;
      const usedP = (posByBundle[k] || 0) / equity * 100, capP = b.total_position_pct, overP = capP != null && usedP > capP;
      return `<div class="opt-tile"><div class="opt-k">${esc(k)}</div>`
        + `<div class="opt-v"${overR ? ' style="color:var(--down)"' : ""}>在险 ${usedR.toFixed(1)}%${capR != null ? ` / ${capR}%${overR ? " ⚠️" : ""}` : ""}`
        + `<span class="opt-sub"${overP ? ' style="color:var(--down)"' : ""}>仓位 ${usedP.toFixed(1)}%${capP != null ? ` / ${capP}%${overP ? " ⚠️" : ""}` : ""}</span></div></div>`;
    }).join("")}</div>
    <div class="muted small" style="margin-top:6px">组合总在险 = 所有持仓在险之和(若止损全被打的总亏损)。${totalPct > maxHeat ? `<span class="down">⚠️ 超总上限 ${maxHeat}%,考虑减仓/收紧止损</span>` : "在上限内。"}</div>
    <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button id="rk-syncpx" class="mini-btn">🔄 同步现价(K线)</button>
      <span class="muted small">现价源:${PRICE_OVERRIDE ? `K线同步 @ ${(PRICE_SYNCED_AT || "").slice(5, 16).replace("T", " ")}` : "portfolio.json(MCP 刷新价;点 🔄 手动同步 K线)"}</span>
    </div>
    <div class="muted small" style="margin-top:6px">分组改动已本地自动保存(localStorage);点顶部「💾 保存到 config」把 thesis + 分组一起发布给 agent(需 PAT)。</div>`;

  host.querySelectorAll(".rk-grp").forEach((el) => el.addEventListener("change", () => { ASSIGN[el.dataset.sym] = el.value; const g = rLS("riskGroups", {}); g[el.dataset.sym] = el.value; rLSset("riskGroups", g); renderRiskExposure(); rpSchedule(true); }));   // 分组改动 → 自动同步私有库
  const mh = $("rk-maxheat"); if (mh) mh.addEventListener("change", () => { MAXHEAT = +mh.value || 0; rLSset("riskMaxHeat", MAXHEAT); renderRiskExposure(); rpSchedule(true); });   // 本机即时持久化 + 自动同步私有库
  host.querySelectorAll(".rk-sort").forEach((th) => th.addEventListener("click", () => {   // 点表头排序:同列切方向,换列文本升/数值降
    const k = th.dataset.k;
    SORT = SORT.key === k ? { key: k, dir: -SORT.dir } : { key: k, dir: (k === "sym" || k === "bundleName") ? 1 : -1 };
    renderRiskExposure();
  }));
  host.querySelectorAll(".rk-stopin").forEach((el) => el.addEventListener("change", () => { const s = rLS("riskStops", {}), v = el.value.trim(); if (v === "") delete s[el.dataset.sym]; else s[el.dataset.sym] = +v; rLSset("riskStops", s); renderRiskExposure(); }));
  host.querySelectorAll(".rk-tpin").forEach((el) => el.addEventListener("change", () => { const t = rLS("riskTargets", {}), v = el.value.trim(); if (v === "") delete t[el.dataset.sym]; else t[el.dataset.sym] = +v; rLSset("riskTargets", t); renderRiskExposure(); }));   // 止盈价:空=删除→留白
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

/* 交易复盘:计划(事前登记 edge+计划价+thesis)→ 归因(平仓后只判流程/守没守计划,不看结果)。
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
  const today = new Date().toISOString().slice(0, 10);
  const dirOpts = (cur) => ["多", "空"].map((d) => `<option${d === cur ? " selected" : ""}>${d}</option>`).join("");
  const bOpts = (cur) => Object.keys(pol.bundles || {}).map((b) => `<option${b === cur ? " selected" : ""}>${esc(b)}</option>`).join("");
  const expired = (e) => e.shelf && e.status !== "closed" && e.shelf < today;   // 保质期已过且仍持仓
  const form = `
    <div class="risk-form" style="margin-bottom:8px">
      <label>标的<input id="j-sym" style="width:78px" placeholder="TSLA"></label>
      <label>方向<select id="j-dir"><option>多</option><option>空</option></select></label>
      <label>Thesis<select id="j-bundle">${bopts}</select></label>
      <label>进场<input id="j-entry" type="number" step="0.01" style="width:84px" placeholder="可选"></label>
      <label>止损<input id="j-stop" type="number" step="0.01" style="width:84px" placeholder="可选"></label>
      <label>目标<input id="j-target" type="number" step="0.01" style="width:84px" placeholder="可选"></label>
      <label>股数<input id="j-size" type="number" style="width:72px" placeholder="可选"></label>
      <label>Shelf life<input id="j-shelf" type="date" style="width:140px" title="thesis 有效期;过期未走出=复盘/离场(可选)"></label>
    </div>
    <div class="risk-form" style="margin-bottom:8px">
      <label style="flex:1;min-width:260px">Edge (why enter)<input id="j-thesis" style="width:100%" placeholder="突破前高 $96 变支撑 + HBM 卡位…"></label>
      <label style="flex:1;min-width:260px">Invalidation (thesis 被推翻=离场,非"亏X%")<input id="j-invalid" style="width:100%" placeholder="跌回 $96 下方 / 指引下调…"></label>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
      <button id="j-add" class="mini-btn">＋记录计划</button>
      <button id="j-push" class="mini-btn">💾 存到私有库(换机器不丢)</button>
      <button id="j-export" class="mini-btn">导出 JSON</button>
      <span id="j-msg" class="muted small">${stat}</span>
    </div>`;
  const plan = (e) => `<b>${esc(e.sym)}</b> <span class="${e.dir === "空" ? "down" : "up"}">${e.dir}</span> · ${esc(e.bundle || "")} · 进 ${e.entry ?? "?"} / 止 ${e.stop ?? "?"} / 标 ${e.target ?? "?"} · ${e.size ?? "?"}股${e.shelf ? ` · Shelf life ${e.shelf}` : ""} <span class="muted small">${(e.ts || "").slice(0, 10)}</span><br><span class="muted small">Edge: ${esc(e.thesis || "—")} | Invalidation: ${esc(e.invalid || "—")}</span>`;
  // 持仓中的计划:所有字段直接可编辑(执行中随时改),「保存修改」落本机;平仓归因也会一并保存当前编辑。
  const openCard = (e) => `<div class="card" style="margin:6px 0" data-id="${e.id}">
    <div class="muted small" style="margin-bottom:6px">计划(执行中可随时改)· 建于 ${(e.ts || "").slice(0, 10)}${e.shelf ? ` · Shelf life ${e.shelf}${expired(e) ? ' <span class="down">⏰ Expired</span>' : ""}` : ""}</div>
    <div class="risk-form">
      <label>标的<input class="je-sym" value="${esc(e.sym || "")}" style="width:78px"></label>
      <label>方向<select class="je-dir">${dirOpts(e.dir)}</select></label>
      <label>Thesis<select class="je-bundle">${bOpts(e.bundle)}</select></label>
      <label>进场<input class="je-entry" type="number" step="0.01" value="${e.entry ?? ""}" style="width:84px" placeholder="可选"></label>
      <label>止损<input class="je-stop" type="number" step="0.01" value="${e.stop ?? ""}" style="width:84px" placeholder="可选"></label>
      <label>目标<input class="je-target" type="number" step="0.01" value="${e.target ?? ""}" style="width:84px" placeholder="可选"></label>
      <label>股数<input class="je-size" type="number" value="${e.size ?? ""}" style="width:72px" placeholder="可选"></label>
      <label>Shelf life<input class="je-shelf" type="date" value="${esc(e.shelf || "")}" style="width:140px"></label>
    </div>
    <div class="risk-form" style="margin-top:6px">
      <label style="flex:1;min-width:260px">Edge<input class="je-thesis" value="${esc(e.thesis || "")}" style="width:100%"></label>
      <label style="flex:1;min-width:260px">Invalidation<input class="je-invalid" value="${esc(e.invalid || "")}" style="width:100%"></label>
    </div>
    <div class="risk-form" style="margin-top:6px;align-items:flex-end">
      <button class="jc-edit mini-btn">💾 保存修改</button>
      <label>平仓价<input class="jc-exit" type="number" step="0.01" style="width:84px" placeholder="可选"></label>
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
  const readPlan = (card) => {   // 从可编辑卡片读回全部计划字段(进/止/标/股/保质期均可选)
    const q = (c) => card.querySelector(c);
    return { sym: (q(".je-sym").value || "").trim().toUpperCase(), dir: q(".je-dir").value, bundle: q(".je-bundle").value,
      entry: +q(".je-entry").value || null, stop: +q(".je-stop").value || null, target: +q(".je-target").value || null,
      size: +q(".je-size").value || null, shelf: q(".je-shelf").value || null,
      thesis: q(".je-thesis").value.trim(), invalid: q(".je-invalid").value.trim() };
  };
  $("j-add").addEventListener("click", () => {
    const sym = ($("j-sym").value || "").trim().toUpperCase(); if (!sym) return;
    const e = { id: Date.now(), ts: new Date().toISOString(), status: "open", sym, dir: $("j-dir").value,
      bundle: $("j-bundle").value, entry: +$("j-entry").value || null, stop: +$("j-stop").value || null,
      target: +$("j-target").value || null, size: +$("j-size").value || null, shelf: $("j-shelf").value || null,
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
  host.querySelectorAll(".jc-edit").forEach((btn) => btn.addEventListener("click", (ev) => {
    const card = ev.target.closest("[data-id]"), id = +card.dataset.id, p = readPlan(card);
    save(J.map((e) => e.id !== id ? e : { ...e, ...p, sym: p.sym || e.sym }));
  }));
  host.querySelectorAll(".jc-close").forEach((btn) => btn.addEventListener("click", (ev) => {
    const card = ev.target.closest("[data-id]"), id = +card.dataset.id, p = readPlan(card);   // 平仓时一并保存当前编辑
    const arr = J.map((e) => e.id !== id ? e : { ...e, ...p, sym: p.sym || e.sym, status: "closed", ts_close: new Date().toISOString(),
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
