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
function assemble(J, direction = "bear", entity = "market") {
  const ent = J.directions[direction].entities[entity];
  const feats = [...J.macro_features, ...ent.tech_features];
  const X = J.dates.map((_, i) => feats.map((f) => J.data[f][i]));
  const t = ent.targets;
  return { feats, X, ent, y: t.y_bear12, nb: t.next_bear_id, ib: t.in_bear_id };
}

function fitStd(X, idx, nf) {
  return Array.from({ length: nf }, (_, j) => {
    const vals = idx.map((i) => X[i][j]).filter((v) => v != null);
    return [mean(vals), std(vals)];
  });
}
const applyStd = (X, idx, prm) => idx.map((i) => prm.map(([m, s], j) => { const v = X[i][j]; return v == null ? 0 : (v - m) / s; }));
const predict = (rows, w) => rows.map((r) => sigmoid([1, ...r].reduce((s, v, j) => s + v * w[j], 0)));

/* 核心:LOBO + 终模型 */
function runModel(A, lam = LAM) {
  const { feats, X, y, nb, ib } = A;
  const N = X.length, nf = feats.length;
  const calm = (i) => nb[i] === 0 && ib[i] === 0;
  const bears = [...new Set(nb.filter((v) => v > 0))].sort((a, b) => a - b);
  const idxAll = [...Array(N).keys()];
  const aucByBear = {};
  for (const k of bears) {
    const others = bears.filter((b) => b !== k);
    const tr = idxAll.filter((i) => (others.includes(nb[i]) || calm(i)) && y[i] != null);
    const sc = idxAll.filter((i) => nb[i] === k || calm(i));
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
function chartProbVsBears(J, dir, probAll) {
  const dates = J.dates, eps = J.directions[dir].entities.market.episodes;
  const W = 1000, H = 300, pl = 44, pr = 12, pt = 16, pb = 26, iw = W - pl - pr, ih = H - pt - pb;
  const n = dates.length;
  const x = (i) => pl + i / (n - 1) * iw;
  const y = (v) => pt + (1 - v) * ih;
  const di = {}; dates.forEach((d, i) => (di[d.slice(0, 7)] = i));
  const dayi = (d) => di[d.slice(0, 7)] ?? null;
  // 熊市阴影(峰→谷)按 class 着色
  const shades = eps.map((e) => {
    const a = dayi(e.peak), b = dayi(e.trough);
    if (a == null || b == null) return "";
    return `<rect x="${x(a).toFixed(1)}" y="${pt}" width="${(x(b) - x(a)).toFixed(1)}" height="${ih}" fill="${CLASS_COLOR[e.class]}" opacity="0.16"><title>#${e.id} ${e.peak}→${e.trough} ${(e.dd * 100).toFixed(0)}% · ${CLASS_LABEL[e.class]}</title></rect>`;
  }).join("");
  const pts = probAll.map((v, i) => v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`).filter(Boolean).join(" ");
  const yt = [0, 0.25, 0.5, 0.75, 1].map((v) => `<line x1="${pl}" y1="${y(v).toFixed(1)}" x2="${pl + iw}" y2="${y(v).toFixed(1)}" stroke="var(--border)"/><text x="${pl - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${v}</text>`).join("");
  const xt = dates.map((d, i) => (d.slice(5, 7) === "12" && +d.slice(0, 4) % 5 === 0) ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--muted)">${d.slice(0, 4)}</text>` : "").join("");
  const last = probAll[probAll.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px">
    ${yt}${shades}
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
    ${xt}
    <text x="${pl + iw}" y="${(y(last) - 5).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--accent)">当前 ${(last * 100).toFixed(0)}%</text>
  </svg>
  <div class="muted small">蓝线=模型拟合的熊市预警概率(全样本);阴影=历史熊市(红=内生/黄=政策/灰=外生冲击),hover 看详情。</div>`;
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
      ${tile("全部可评估", sub(() => true))}
      ${tile("仅可预见(内生+政策)", sub((c) => c !== "exogenous"), "外生冲击(COVID/1987/1990)不计入")}
    </div>
    <div class="muted small">LOBO AUC:留出该熊市、用其余熊市训练,再看能否认出它。&gt;0.5 有效。外生冲击本不该被预测,单列不拉低主指标。</div>`;
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
  $("bb-chart").innerHTML = chartProbVsBears(J, "bear", res.probAll);
  $("bb-score").innerHTML = scorecard(J, "bear", res);
  $("bb-coef").innerHTML = coefBars(res);
}

main();
