/* 策略回测页(PR3):读 data/strategy_bt.json,渲染统计 + 权益曲线 + 逐笔交易。只读,静态。 */
import { $, esc, loadFreshJSON } from "./shared.js";
const LWC = window.LightweightCharts;

function tile(k, v, sub = "", cls = "") {
  return `<div class="opt-tile"><div class="opt-k">${k}</div><div class="opt-v ${cls}">${v}${sub ? ` <span class="opt-sub">${sub}</span>` : ""}</div></div>`;
}

async function main() {
  const d = await loadFreshJSON("data/strategy_bt.json");
  if (!d || !Array.isArray(d.equity_curve) || !d.equity_curve.length) {
    $("bt-empty").style.display = "block";
    $("bt-empty").textContent = "还没有回测结果 —— 由采集时的 strategy_run 生成(读 flow_history)。先让样本攒够几轮。";
    return;
  }
  $("bt-sub").textContent = `${d.sym} · 信号 ${d.signal} · ${d.n_bars} bars`;
  $("bt-caveat").innerHTML = `<b>⚠️ 示例,非验证策略</b> · ${esc(d.caveat || "信号/参数为示例,有效性待验证。")}`;

  const up = (v) => (v ?? 0) >= 0 ? "up" : "down";
  $("bt-stats").innerHTML = [
    tile("Trades", d.total_trades ?? 0),
    tile("Win rate", (d.win_rate ?? 0) + "%"),
    tile("Total return", ((d.total_return_pct ?? 0) >= 0 ? "+" : "") + (d.total_return_pct ?? 0) + "%", "", up(d.total_return_pct)),
    tile("Max DD", "−" + (d.max_drawdown_pct ?? 0) + "%", "", "down"),
    tile("TP / SL", d.take_profit_pct + "% / " + d.stop_loss_pct + "%"),
    tile("Max hold", d.max_holding_bars + " bars"),
  ].join("");

  // 权益曲线
  const chart = LWC.createChart($("bt-chart"), {
    layout: { background: { color: "transparent" }, textColor: "#8b96ad" },
    grid: { vertLines: { color: "#1e2941" }, horzLines: { color: "#1e2941" } },
    rightPriceScale: { borderColor: "#2a3550" },
    timeScale: { borderColor: "#2a3550", timeVisible: true },
    height: 360,
  });
  const toT = (t) => typeof t === "number" ? t : Math.floor(Date.parse(t) / 1000);
  const seen = new Set(); const pts = [];
  for (const p of d.equity_curve) {  // LWC 要求 time 严格递增且唯一
    const t = toT(p.t);
    if (Number.isFinite(t) && !seen.has(t)) { seen.add(t); pts.push({ time: t, value: p.equity }); }
  }
  pts.sort((a, b) => a.time - b.time);
  chart.addLineSeries({ color: "#60a5fa", lineWidth: 2 }).setData(pts);
  chart.timeScale().fitContent();

  // 逐笔交易
  $("bt-trades-n").textContent = `(${d.trades.length})`;
  const rows = d.trades.map((t) => `<tr>
    <td>${esc(String(t.entry_time))}</td><td>${esc(String(t.exit_time))}</td>
    <td>${t.type}</td><td>${t.entry_price}</td><td>${t.exit_price}</td>
    <td class="${t.return_pct >= 0 ? "up" : "down"}">${t.return_pct >= 0 ? "+" : ""}${t.return_pct}%</td>
    <td>${t.bars_held}</td><td class="muted">${esc(t.reason)}</td></tr>`).join("");
  $("bt-trades").innerHTML = `<table class="bt-table"><thead><tr>
    <th>Entry</th><th>Exit</th><th>Type</th><th>In</th><th>Out</th><th>Ret</th><th>Bars</th><th>Reason</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}
main();
