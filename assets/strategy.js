/* 策略回测页(PR7):读 data/strategy_bt.json,渲染统计 + 指标 + 权益曲线(叠加基准)+ OOS + 交易。只读。 */
import { $, esc, loadJSON, loadFreshJSON, getPat, ghHeaders, REPO } from "./shared.js";
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

async function main() {
  // 5Y 走势聚合 与 净 GEX→次日波动 研究 已迁移到 research 页(收益率×市场 / GEX→波动 两个 tab)
  await renderRiskControl();   // 账户风险控制:独立于回测数据,始终显示
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
