/* 策略回测页(PR7):读 data/strategy_bt.json,渲染统计 + 指标 + 权益曲线(叠加基准)+ OOS + 交易。只读。 */
import { $, esc, loadJSON, loadFreshJSON } from "./shared.js";
const LWC = window.LightweightCharts;

/* 账户风险控制 · 仓位计算器。读 config/risk_policy.json(固定参数,日后 agentic 读同一份)。
   核心:单笔风险预算=净值×risk_pct;止损决定仓位 shares=budget/(entry−stop);仓位≤max_position_pct。 */
async function renderRiskControl() {
  const host = $("risk-control"); if (!host) return;
  const P = (await loadJSON("config/risk_policy.json")) || {};
  const tiers = P.risk_tiers || { normal: { label: "常规", risk_pct: 0.75 } };
  const atr = P.atr || { period: 14, mult_default: 2.0 };
  const maxPos = P.max_position_pct ?? 20;
  const tierOpts = Object.entries(tiers).map(([k, t]) =>
    `<option value="${k}"${k === (P.default_tier || "normal") ? " selected" : ""}>${esc(t.label)} · ${t.risk_pct}%</option>`).join("");
  host.innerHTML = `
    <div class="risk-form">
      <label>账户净值 $<input id="rk-eq" type="number" value="${P.account_equity ?? 100000}" step="1000"></label>
      <label>风险档<select id="rk-tier">${tierOpts}</select></label>
      <label>买入价 $<input id="rk-entry" type="number" value="100" step="0.01"></label>
      <label>止损法<select id="rk-mode"><option value="manual">手动止损价</option><option value="atr">ATR 法</option></select></label>
      <label id="rk-stop-wrap">止损价 $<input id="rk-stop" type="number" value="94" step="0.01"></label>
      <label id="rk-atr-wrap" style="display:none">ATR${atr.period} $<input id="rk-atr" type="number" value="3" step="0.01"> × 倍<input id="rk-mult" type="number" value="${atr.mult_default}" step="0.1" style="width:60px"></label>
    </div>
    <div id="rk-out" class="wb-statbar" style="margin-top:12px"></div>
    <div id="rk-note" class="muted small" style="margin-top:6px"></div>
    <div class="muted small" style="margin-top:10px"><b>止损放在 thesis 被证伪处</b>(不是"亏 X% 就卖"):${(P.stop_bases || []).map(esc).join(" · ")}。<br>核心:<b>止损位决定仓位</b>;仓位上限 ${maxPos}% 净值;越高波动 stop 越宽、仓位越小。</div>`;
  const g = (id) => +$(id).value;
  const T = (k, v, sb = "", cls = "") => `<div class="opt-tile"><div class="opt-k">${k}</div><div class="opt-v ${cls}">${v}${sb ? ` <span class="opt-sub">${sb}</span>` : ""}</div></div>`;
  function compute() {
    const eq = g("rk-eq"), entry = g("rk-entry");
    const tier = tiers[$("rk-tier").value] || {};
    const riskPct = tier.risk_pct || 0.75;
    const mode = $("rk-mode").value;
    $("rk-stop-wrap").style.display = mode === "manual" ? "" : "none";
    $("rk-atr-wrap").style.display = mode === "atr" ? "" : "none";
    const stop = mode === "manual" ? g("rk-stop") : entry - g("rk-mult") * g("rk-atr");
    const budget = eq * riskPct / 100, perShare = entry - stop;
    const out = $("rk-out"), note = $("rk-note");
    if (!(eq > 0) || !(entry > 0) || !(perShare > 0)) {
      out.innerHTML = T("提示", "—", "止损须在买入价下方");
      note.textContent = mode === "atr" && entry > 0 ? `ATR 止损 = ${entry} − ${g("rk-mult")}×${g("rk-atr")} = ${stop.toFixed(2)}` : "";
      return;
    }
    let shares = Math.floor(budget / perShare);
    let posDollar = shares * entry, posPct = posDollar / eq * 100, capped = false;
    if (posPct > maxPos) {
      capped = true;
      shares = Math.floor(eq * maxPos / 100 / entry);
      posDollar = shares * entry; posPct = posDollar / eq * 100;
    }
    const actualRisk = shares * perShare;
    out.innerHTML = [
      T("风险预算", "$" + budget.toFixed(0), `${riskPct}% × 净值`, "down"),
      T("止损价", "$" + stop.toFixed(2), `每股风险 $${perShare.toFixed(2)}`),
      T("仓位股数", shares.toLocaleString(), capped ? `压到 ${maxPos}% 上限` : "", "up"),
      T("仓位金额", "$" + posDollar.toFixed(0), `${posPct.toFixed(1)}% 净值`),
      T("实际风险", "$" + actualRisk.toFixed(0), `${(actualRisk / eq * 100).toFixed(2)}% 净值`, "down"),
    ].join("");
    note.innerHTML = `${shares.toLocaleString()} 股 = 预算 $${budget.toFixed(0)} ÷ 每股风险 $${perShare.toFixed(2)}`
      + (capped ? ` · <span class="down">触发 ${maxPos}% 仓位上限 → 压低股数(实际风险 < 预算)</span>` : "")
      + (mode === "atr" ? ` · ATR 止损 = ${entry} − ${g("rk-mult")}×${g("rk-atr")} = ${stop.toFixed(2)}` : "");
  }
  ["rk-eq", "rk-tier", "rk-entry", "rk-mode", "rk-stop", "rk-atr", "rk-mult"].forEach((id) => {
    const el = $(id); if (el) { el.addEventListener("input", compute); el.addEventListener("change", compute); }
  });
  compute();
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
