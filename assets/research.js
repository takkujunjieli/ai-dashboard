/* Research 页 — 多 topic 研究台。Topic 1:熊/牛预测(v1 熊侧)。
   模型在浏览器里跑(approach A):L2 正则 logistic(IRLS)+ leave-one-bear-out。
   数据 data/research_bearbull.json(topic/方向/实体三层可扩展)。 */
import { $, esc, loadJSON } from "./shared.js";

const LAM = 10;            // L2 强度(与 factorlab/model.py 默认一致)
const CLASS_COLOR = { endogenous: "#f87171", policy: "#fbbf24", exogenous: "#8b96ad", unknown: "#8b96ad" };
const CLASS_LABEL = { endogenous: "内生", policy: "政策", exogenous: "外生", unknown: "?" };

/* ---------- 线性代数 / 模型 ---------- */
function solve(A, b) {                       // 高斯消元 + 部分主元
  const n = b.length, M = A.map((r, i) => r.concat(b[i]));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / piv;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / (M[i][i] || 1e-12));
}

function ridgeLogistic(X, y, lam, iters = 60) {   // IRLS;截距不罚
  const n = X.length, p = X[0].length, dim = p + 1;
  const Xb = X.map((r) => [1, ...r]);
  let w = new Array(dim).fill(0);
  for (let it = 0; it < iters; it++) {
    const A = Array.from({ length: dim }, () => new Array(dim).fill(0));
    const bb = new Array(dim).fill(0);
    for (let i = 0; i < n; i++) {
      const eta = Xb[i].reduce((s, v, j) => s + v * w[j], 0);
      const mu = Math.min(1 - 1e-6, Math.max(1e-6, 1 / (1 + Math.exp(-eta))));
      const wd = mu * (1 - mu), z = eta + (y[i] - mu) / wd, row = Xb[i];
      for (let a = 0; a < dim; a++) {
        const ra = row[a] * wd;
        bb[a] += ra * z;
        for (let c = a; c < dim; c++) A[a][c] += ra * row[c];
      }
    }
    for (let a = 0; a < dim; a++) for (let c = 0; c < a; c++) A[a][c] = A[c][a];
    for (let a = 1; a < dim; a++) A[a][a] += lam;
    const wn = solve(A, bb);
    let d = 0;
    for (let a = 0; a < dim; a++) d = Math.max(d, Math.abs(wn[a] - w[a]));
    w = wn;
    if (d < 1e-8) break;
  }
  return w;
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

function auc(scores, labels) {                 // Mann-Whitney rank AUC
  const pairs = scores.map((s, i) => [s, labels[i]]).filter((p) => p[0] != null);
  const npos = pairs.filter((p) => p[1] === 1).length, nneg = pairs.length - npos;
  if (!npos || !nneg) return null;
  pairs.sort((a, b) => a[0] - b[0]);
  let rank = 0, rsum = 0;
  for (let i = 0; i < pairs.length;) {          // 处理并列:平均秩
    let j = i; while (j < pairs.length && pairs[j][0] === pairs[i][0]) j++;
    const avg = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (pairs[k][1] === 1) rsum += avg;
    i = j;
  }
  return (rsum - npos * (npos + 1) / 2) / (npos * nneg);
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
function std(a) { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))) || 1; }

/* 从 json 组装:特征矩阵 X(行=月,列=特征,允许 null)、target/标注 */
function assembleFeats(J, featList, direction = "bear", entity = "market") {
  const ent = J.directions[direction].entities[entity];
  const feats = featList.filter((f) => J.data[f]);
  const X = J.dates.map((_, i) => feats.map((f) => J.data[f][i]));
  const t = ent.targets;
  return { feats, X, ent, y: t.y_bear12, nb: t.next_bear_id, ib: t.in_bear_id };
}
function assemble(J, direction = "bear", entity = "market") {
  const ent = J.directions[direction].entities[entity];
  return assembleFeats(J, [...J.macro_features, ...ent.tech_features], direction, entity);
}
// 3 变量领先基准(曲线+信用+估值):文献支持、极简、抗过拟合
const LEADING3 = ["term_10y3m", "gz_spread", "bm"];

function fitStd(X, idx, nf) {
  return Array.from({ length: nf }, (_, j) => {
    const vals = idx.map((i) => X[i][j]).filter((v) => v != null);
    return [mean(vals), std(vals)];
  });
}
const applyStd = (X, idx, prm) => idx.map((i) => prm.map(([m, s], j) => { const v = X[i][j]; return v == null ? 0 : (v - m) / s; }));
const predict = (rows, w) => rows.map((r) => sigmoid([1, ...r].reduce((s, v, j) => s + v * w[j], 0)));

/* 核心:LOBO(purged + embargoed)+ 终模型。与 factorlab/model.py 一致:
   ① 每个 calm 月按"离哪次熊市峰最近"唯一归属某折,只在那折当负样本,绝不同时进训练;
   ② embargo:留出第 k 段时,把它 [预警窗起-E, 谷底+E] 内所有月从训练删掉(隔断自相关泄漏)。
   面板为连续月频 → 用行号距离当月份距离(1 行=1 月)。 */
function runModel(A, lam = LAM, embargo = 12) {
  const { feats, X, y, nb, ib } = A;
  const N = X.length, nf = feats.length;
  const calm = (i) => nb[i] === 0 && ib[i] === 0;
  const bears = [...new Set(nb.filter((v) => v > 0))].sort((a, b) => a - b);
  const idxAll = [...Array(N).keys()];
  // 每次熊市:峰(=预警窗最后一月行号)、跨度(预警窗起→谷底)
  const peakIdx = {}, spanStart = {}, spanEnd = {};
  for (const k of bears) {
    const warnRows = idxAll.filter((i) => nb[i] === k);
    const inbRows = idxAll.filter((i) => ib[i] === k);
    peakIdx[k] = Math.max(...warnRows);
    spanStart[k] = Math.min(...warnRows);
    spanEnd[k] = inbRows.length ? Math.max(...inbRows) : peakIdx[k];
  }
  // calm 月唯一归属最近的熊市峰
  const owner = {};
  for (const i of idxAll) if (calm(i)) {
    let best = bears[0], bd = Infinity;
    for (const k of bears) { const d = Math.abs(i - peakIdx[k]); if (d < bd) { bd = d; best = k; } }
    owner[i] = best;
  }
  const aucByBear = {};
  for (const k of bears) {
    const lo = spanStart[k] - embargo, hi = spanEnd[k] + embargo;
    const embargoed = (i) => i >= lo && i <= hi;
    const testCalm = (i) => calm(i) && owner[i] === k;
    const others = bears.filter((b) => b !== k);
    const tr = idxAll.filter((i) => !embargoed(i) && (others.includes(nb[i]) || (calm(i) && !testCalm(i))) && y[i] != null);
    const sc = idxAll.filter((i) => nb[i] === k || testCalm(i));
    const prm = fitStd(X, tr, nf);
    const w = ridgeLogistic(applyStd(X, tr, prm), tr.map((i) => y[i]), lam);
    const prob = predict(applyStd(X, sc, prm), w);
    const lab = sc.map((i) => (nb[i] === k ? 1 : 0));
    const a = auc(prob, lab);
    if (a != null) aucByBear[k] = a;
  }
  const full = idxAll.filter((i) => (nb[i] > 0 || calm(i)) && y[i] != null);
  const prm = fitStd(X, full, nf);
  const w = ridgeLogistic(applyStd(X, full, prm), full.map((i) => y[i]), lam);
  const probAll = predict(applyStd(X, idxAll, prm), w);
  const coef = feats.map((f, j) => [f, w[j + 1]]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return { aucByBear, probAll, coef, bears };
}

/* ---------- 渲染 ---------- */
// 归一到起点=100(便于把量级差很大的两条指数放同一对数轴上比走势)
function norm100(arr) {
  const f = arr.find((v) => v != null && v > 0);
  return f ? arr.map((v) => (v == null ? null : v / f * 100)) : arr;
}

// series:[{name,prob,color,w,dash}];prices:[{name,data,color}](已 norm100)
function chartProbVsBears(J, dir, series, benchmarks) {
  const dates = J.dates, eps = J.directions[dir].entities.market.episodes;
  const W = 1000, H = 320, pl = 40, pr = 40, pt = 16, pb = 26, iw = W - pl - pr, ih = H - pt - pb;
  const n = dates.length;
  const x = (i) => pl + i / (n - 1) * iw;
  const y = (v) => pt + (1 - v) * ih;                       // 左轴:概率 0..1
  const di = {}; dates.forEach((d, i) => (di[d.slice(0, 7)] = i));
  const dayi = (d) => di[d.slice(0, 7)] ?? null;

  // 右轴:大盘指数(对数,起点=100)
  const prices = [
    { name: "标普500", data: norm100(benchmarks.sp500 || []), color: "#94a3b8" },
    { name: "纳斯达克", data: norm100(benchmarks.nasdaq || []), color: "#2dd4bf" },
  ].filter((p) => p.data.some((v) => v != null));
  const allP = prices.flatMap((p) => p.data).filter((v) => v != null && v > 0);
  const loMin = allP.length ? Math.log10(Math.min(...allP)) : 2, loMax = allP.length ? Math.log10(Math.max(...allP)) : 4;
  const yP = (v) => pt + (1 - (Math.log10(v) - loMin) / (loMax - loMin || 1)) * ih;
  const priceLines = prices.map((p) => {
    const pts = p.data.map((v, i) => (v == null || v <= 0) ? null : `${x(i).toFixed(1)},${yP(v).toFixed(1)}`).filter(Boolean).join(" ");
    return `<polyline points="${pts}" fill="none" stroke="${p.color}" stroke-width="1" opacity="0.8"/>`;
  }).join("");
  const decades = [];
  for (let e = Math.ceil(loMin); e <= Math.floor(loMax); e++) decades.push(10 ** e);
  const rt = decades.map((v) => `<text x="${(pl + iw + 5).toFixed(1)}" y="${(yP(v) + 3).toFixed(1)}" font-size="9" fill="var(--muted)">${v >= 1000 ? v / 1000 + "k" : v}</text>`).join("");

  // 熊市阴影(峰→谷)按 class 着色
  const shades = eps.map((e) => {
    const a = dayi(e.peak), b = dayi(e.trough);
    if (a == null || b == null) return "";
    return `<rect x="${x(a).toFixed(1)}" y="${pt}" width="${(x(b) - x(a)).toFixed(1)}" height="${ih}" fill="${CLASS_COLOR[e.class]}" opacity="0.16"><title>#${e.id} ${e.peak}→${e.trough} ${(e.dd * 100).toFixed(0)}% · ${CLASS_LABEL[e.class]}</title></rect>`;
  }).join("");

  // 概率线(左轴,主角,画在最上层)
  const probLines = series.map((s) => {
    const pts = s.prob.map((v, i) => v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`).filter(Boolean).join(" ");
    return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="${s.w || 1.6}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`;
  }).join("");

  const yt = [0, 0.25, 0.5, 0.75, 1].map((v) => `<line x1="${pl}" y1="${y(v).toFixed(1)}" x2="${pl + iw}" y2="${y(v).toFixed(1)}" stroke="var(--border)"/><text x="${pl - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${v}</text>`).join("");
  const xt = dates.map((d, i) => (d.slice(5, 7) === "12" && +d.slice(0, 4) % 5 === 0) ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--muted)">${d.slice(0, 4)}</text>` : "").join("");

  const legend = [
    ...series.map((s) => `<span style="white-space:nowrap"><span style="color:${s.color};font-weight:700">${s.dash ? "▬ ▬" : "▬▬"}</span> ${esc(s.name)}(当前 ${(s.prob[s.prob.length - 1] * 100).toFixed(0)}%)</span>`),
    ...prices.map((p) => `<span style="white-space:nowrap"><span style="color:${p.color};font-weight:700">▬</span> ${esc(p.name)}</span>`),
    `<span style="white-space:nowrap">阴影=历史熊市(<span style="color:${CLASS_COLOR.endogenous}">内生</span>/<span style="color:${CLASS_COLOR.policy}">政策</span>/<span style="color:${CLASS_COLOR.exogenous}">外生</span>)</span>`,
  ].join("");

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px">
    ${yt}${shades}${priceLines}${probLines}${rt}${xt}
    <text x="${pl - 6}" y="${pt - 4}" text-anchor="end" font-size="9" fill="var(--muted)">概率</text>
    <text x="${(pl + iw + 5).toFixed(1)}" y="${pt - 4}" font-size="9" fill="var(--muted)">指数·log</text>
  </svg>
  <div class="muted small" style="display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:8px">${legend}</div>
  <div class="muted small" style="margin-top:4px">左轴=模型全样本拟合的熊市预警概率;右轴=大盘指数(对数,各自起点=100)。3 变量=曲线(10Y-3M)+信用(GZ 利差)+估值(b/m),文献支持的极简领先基准;23 特征=全信号(含价格同步项)。</div>`;
}

function scorecard(J, dir, res) {
  const eps = J.directions[dir].entities.market.episodes;
  const rows = eps.map((e) => {
    const a = res.aucByBear[e.id];
    const av = a == null ? "—" : a.toFixed(3);
    const cls = a == null ? "" : (a > 0.5 ? "up" : "down");
    return `<tr><td>#${e.id}</td><td>${e.peak.slice(0, 7)}→${e.trough.slice(0, 7)}</td>
      <td>${(e.dd * 100).toFixed(0)}%</td>
      <td><span style="color:${CLASS_COLOR[e.class]}">${CLASS_LABEL[e.class]}</span></td>
      <td class="${cls}">${av}</td></tr>`;
  }).join("");
  const sub = (pred) => {
    const vals = eps.filter((e) => res.aucByBear[e.id] != null && (pred(e.class))).map((e) => res.aucByBear[e.id]);
    if (!vals.length) return "—";
    const hit = vals.filter((v) => v > 0.5).length;
    return `mean ${mean(vals).toFixed(3)} · min ${Math.min(...vals).toFixed(3)} · hit ${hit}/${vals.length}`;
  };
  return `<table class="bt-table"><tr><th>#</th><th>熊市(峰→谷)</th><th>跌幅</th><th>可预测性</th><th>LOBO AUC</th></tr>${rows}</table>
    <div class="opt-grid" style="margin-top:10px">
      ${tile("全部可评估", sub(() => true), "9 次揉成一个均值 → 会骗人")}
      ${tile("内生簇(信用/估值/曲线)", sub((c) => c === "endogenous"), "1998 / 2000 / 2007 — 稳健可预警")}
    </div>
    <div class="muted small">LOBO(embargo + 净基线,口径同 factorlab/model.py):留出该熊市(含其邻近月做 embargo)、用其余熊市训练,再看能否认出它。&gt;0.5 有效。<b>修正泄漏后真相是双峰的</b>:内生(信用/估值/曲线驱动)≈0.93 稳健;而通胀-政策冲击(2022,甚至反向 &lt;0.5)与纯外生(COVID)本质不可预测——别被"全部平均"骗了。</div>`;
}

function tile(k, v, sub = "") {
  return `<div class="opt-tile"><div class="opt-k">${esc(k)}</div><div class="opt-v" style="font-size:13px">${esc(v)}</div>${sub ? `<div class="opt-sub">${esc(sub)}</div>` : ""}</div>`;
}

function coefBars(res) {
  const top = res.coef.slice(0, 14);
  const mx = Math.max(...top.map((c) => Math.abs(c[1]))) || 1;
  const rows = top.map(([f, c]) => {
    const w = Math.abs(c) / mx * 46, col = c >= 0 ? "var(--down)" : "var(--up)";
    const bar = c >= 0
      ? `<span style="display:inline-block;width:50%;text-align:right"></span><span style="display:inline-block;width:${w}%;height:10px;background:${col}"></span>`
      : `<span style="display:inline-block;width:${50 - w}%"></span><span style="display:inline-block;width:${w}%;height:10px;background:${col};float:right"></span>`;
    return `<div style="display:flex;align-items:center;gap:8px;margin:3px 0">
      <span style="width:150px;text-align:right;font-size:12px" class="muted">${esc(f)}</span>
      <span style="flex:1">${bar}</span>
      <span style="width:52px;font-size:11px" class="${c >= 0 ? "down" : "up"}">${c >= 0 ? "+" : ""}${c.toFixed(2)}</span></div>`;
  }).join("");
  return `${rows}<div class="muted small" style="margin-top:6px">标准化系数:<span class="down">红=推高</span>预警 / <span class="up">绿=压低</span>。⚠️ 特征相关时个别系数符号可能翻转,别单独解读。</div>`;
}

/* ---------- 主流程 ---------- */
async function main() {
  const J = await loadJSON("data/research_bearbull.json");
  if (!J) { $("r-status").textContent = "缺 data/research_bearbull.json(在 factor-research 跑 export_web.py 生成)"; return; }
  $("r-status").textContent = `Topic: 熊/牛预测 · 熊侧 · ${J.dates[0]}→${J.dates[J.dates.length - 1]} · ${J.dates.length} 月 · 模型在浏览器实时计算(L2-logistic, λ=${LAM})`;
  const A = assemble(J, "bear", "market");
  const res = runModel(A, LAM);
  const res3 = runModel(assembleFeats(J, LEADING3, "bear", "market"), LAM);   // 3 变量领先基准
  const series = [
    { name: "预警概率·23特征", prob: res.probAll, color: "var(--accent)", w: 1.8 },
    { name: "预警概率·3变量", prob: res3.probAll, color: "#c084fc", w: 1.5, dash: "5 3" },
  ];
  $("bb-chart").innerHTML = chartProbVsBears(J, "bear", series, J.benchmarks || {});
  $("bb-score").innerHTML = scorecard(J, "bear", res);
  $("bb-coef").innerHTML = coefBars(res);
}

main();
