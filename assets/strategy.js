/* 策略回测页(PR7):读 data/strategy_bt.json,渲染统计 + 指标 + 权益曲线(叠加基准)+ OOS + 交易。只读。 */
import { $, esc, loadFreshJSON } from "./shared.js";
const LWC = window.LightweightCharts;

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

function renderStudy(s) {  // 研究结论:净 GEX → 次日已实现波动
  if (!s || s.insufficient) return;
  $("bt-study-sec").style.display = "";
  $("bt-study-sub").textContent = `${s.n} 天 · ${s.start}→${s.end}`;
  const rg = s.regime || {}, ic = s.incr || {};
  const q = s.quintiles_pct || [], qmax = Math.max(...q, 0.001);
  const bars = q.map((v, i) =>
    `<div style="display:flex;flex-direction:column;align-items:center;gap:3px">
       <div style="font-size:10px;color:#8b96ad">${v}%</div>
       <div style="width:34px;height:${Math.round(v / qmax * 90)}px;background:#60a5fa;border-radius:3px 3px 0 0"></div>
       <div style="font-size:10px;color:#8b96ad">Q${i + 1}</div>
     </div>`).join("");
  $("bt-study").innerHTML =
    `<div class="wb-statbar">${[
      tile("GEX<0 vs >0 次日波动", (rg.ratio ?? "—") + "×", `${rg.neg_mean_pct}% / ${rg.pos_mean_pct}%`, "down"),
      tile("Spearman", num(s.spearman, 3), `CI [${(s.spearman_ci || []).join(", ")}]`, "down"),
      tile("增量 ΔR²", "+" + num((ic.delta_r2 ?? 0) * 100, 2) + "%", "控制|r_t|后", "up"),
      tile("子期", (s.subperiods || []).map((p) => `${p.label} ${p.spearman}`).join(" · ")),
    ].join("")}</div>
     <div style="display:flex;gap:14px;align-items:flex-end;margin:14px 0 4px;height:120px">${bars}</div>
     <div class="muted small">按 GEX 五分位分组的次日 |r|:低 GEX(Q1)→ 高波动,高 GEX(Q5)→ 低波动(单调,符合 dealer-gamma 抑制/放大机制)。</div>`;
}

/* 5Y 走势聚合:左轴=SPY/QQQ/IWM 归一到100,右轴(虚线)=US 10/30Y 收益率%。独立于回测数据。 */
async function renderRates() {
  const el = $("rates-chart"); if (!el) return;
  const r = await loadFreshJSON("data/rates.json");
  if (!r || !r.series) return;
  const meta = r.meta || {};
  const chart = LWC.createChart(el, {
    layout: { background: { color: "transparent" }, textColor: "#8b96ad" },
    grid: { vertLines: { color: "#1e2941" }, horzLines: { color: "#1e2941" } },
    leftPriceScale: { visible: true, borderColor: "#2a3550" },
    rightPriceScale: { visible: true, borderColor: "#2a3550" },
    timeScale: { borderColor: "#2a3550" },
    height: 380,
  });
  const toLine = (arr) => {
    const seen = new Set(), out = [];
    for (const [d, v] of arr) if (!seen.has(d)) { seen.add(d); out.push({ time: d, value: v }); }
    return out;
  };
  const legend = [];
  for (const [key, arr] of Object.entries(r.series)) {
    if (!arr || !arr.length) continue;
    const m = meta[key] || {}, isYield = m.axis === "yield";
    let data, latest;
    if (isYield) {
      data = toLine(arr);
      latest = arr[arr.length - 1][1].toFixed(2) + "%";
    } else {
      const base = arr[0][1] || 1;
      data = toLine(arr.map(([d, v]) => [d, v / base * 100]));
      const chg = (arr[arr.length - 1][1] / base - 1) * 100;
      latest = (chg >= 0 ? "+" : "") + chg.toFixed(0) + "%";
    }
    chart.addLineSeries({
      color: m.color || "#60a5fa", lineWidth: 2,
      lineStyle: isYield ? LWC.LineStyle.Dashed : LWC.LineStyle.Solid,
      priceScaleId: isYield ? "right" : "left",
      priceLineVisible: false, lastValueVisible: false,
    }).setData(data);
    legend.push(`<span class="rt-leg"><span class="rt-sw" style="background:${m.color || "#60a5fa"}"></span>${esc(m.label || key)} <b>${latest}</b></span>`);
  }
  chart.timeScale().fitContent();
  if ($("rates-legend")) $("rates-legend").innerHTML = legend.join("");
}

async function main() {
  await renderRates();   // 独立面板,回测数据缺失也显示
  const d = await loadFreshJSON("data/strategy_bt.json");
  if (!d || !Array.isArray(d.equity_curve) || !d.equity_curve.length) {
    $("bt-empty").style.display = "block";
    $("bt-empty").textContent = "还没有回测结果 —— 由采集时的 strategy_run 生成(读 gex_daily)。先让样本攒够几天。";
    return;
  }
  renderStudy(d.study);   // 上半:研究结论(有则显示)
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
