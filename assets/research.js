/* Research 页 — 多 topic 研究台。Topic 1:熊/牛预测(v1 熊侧)。
   模型在浏览器里跑(approach A):L2 正则 logistic(IRLS)+ leave-one-bear-out。
   数据 data/research_bearbull.json(topic/方向/实体三层可扩展)。 */
import { $, esc, loadJSON, getPat, ghHeaders, REPO } from "./shared.js";

const LAM = 10;            // L2 强度(与 factorlab/model.py 默认一致)
/* 按"驱动机制"分簇(比 内生/政策/外生 更贴数据、名实相符):
   imbalance=信用扩张过度/估值泡沫/曲线倒挂酝酿的顶 → 模型稳健可预警;
   shock=外生(COVID)或政策 regime 突变(1980 Volcker、2022 通胀加息)→ leading 信号看不到甚至反向。
   成因先验判定(不是拿 AUC 结果倒推),再由 LOBO 验证该簇可不可预测。 */
const DRIVER = {
  1966: "imbalance", 1968: "imbalance", 1972: "imbalance", 1980: "shock", 1987: "imbalance",
  1990: "imbalance", 1998: "imbalance", 2000: "imbalance", 2007: "imbalance", 2020: "shock", 2021: "shock",
};
const DRIVER_COLOR = { imbalance: "#f87171", shock: "#8b96ad" };
const DRIVER_LABEL = { imbalance: "信用/估值", shock: "冲击" };
const DRIVER_NOTE = {
  1966: "信用紧缩(credit crunch)", 1968: "高估值 + 滞胀酝酿", 1972: "Nifty-Fifty 估值泡沫 + 紧缩",
  1980: "Volcker 加息冲击(货币 regime 突变)", 1987: "利率飙升 + 估值拉伸下的结构性崩盘",
  1990: "S&L 信用危机 + 海湾油价", 1998: "LTCM / 俄债信用挤兑", 2000: "互联网估值泡沫破裂",
  2007: "次贷 / 房地产信用危机", 2020: "COVID 外生冲击", 2021: "通胀飙升 + 联储加息 regime 突变",
};
const driverOf = (e) => DRIVER[+e.peak.slice(0, 4)] || "shock";

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
    return `<rect x="${x(a).toFixed(1)}" y="${pt}" width="${(x(b) - x(a)).toFixed(1)}" height="${ih}" fill="${DRIVER_COLOR[driverOf(e)]}" opacity="0.16"><title>#${e.id} ${e.peak}→${e.trough} ${(e.dd * 100).toFixed(0)}% · ${DRIVER_LABEL[driverOf(e)]}(${DRIVER_NOTE[+e.peak.slice(0, 4)] || ""})</title></rect>`;
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
    `<span style="white-space:nowrap">阴影=历史熊市(<span style="color:${DRIVER_COLOR.imbalance}">信用/估值驱动</span>/<span style="color:${DRIVER_COLOR.shock}">冲击</span>)</span>`,
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
    const dv = driverOf(e), yr = +e.peak.slice(0, 4);
    return `<tr><td>#${e.id}</td><td>${e.peak.slice(0, 7)}→${e.trough.slice(0, 7)}</td>
      <td>${(e.dd * 100).toFixed(0)}%</td>
      <td><span style="color:${DRIVER_COLOR[dv]}" title="${esc(DRIVER_NOTE[yr] || "")}">${DRIVER_LABEL[dv]}</span></td>
      <td class="${cls}">${av}</td></tr>`;
  }).join("");
  const sub = (pred) => {
    const vals = eps.filter((e) => res.aucByBear[e.id] != null && pred(driverOf(e))).map((e) => res.aucByBear[e.id]);
    if (!vals.length) return "—";
    const hit = vals.filter((v) => v > 0.5).length;
    return `mean ${mean(vals).toFixed(3)} · min ${Math.min(...vals).toFixed(3)} · hit ${hit}/${vals.length}`;
  };
  return `<table class="bt-table"><tr><th>#</th><th>熊市(峰→谷)</th><th>跌幅</th><th>驱动机制</th><th>LOBO AUC</th></tr>${rows}</table>
    <div class="opt-grid" style="margin-top:10px">
      ${tile("全部可评估", sub(() => true), "9 次揉成一个均值 → 会骗人")}
      ${tile("信用/估值驱动", sub((d) => d === "imbalance"), "内生金融失衡 — 稳健可预警")}
      ${tile("冲击(外生/政策)", sub((d) => d === "shock"), "regime 突变 — 本质不可预警")}
    </div>
    <div class="muted small">按<b>驱动机制</b>分簇(比 内生/政策/外生 名实相符):<span style="color:${DRIVER_COLOR.imbalance}">信用/估值驱动</span>=信用扩张过度 / 估值泡沫 / 曲线倒挂酝酿的顶,模型稳健可预警;<span style="color:${DRIVER_COLOR.shock}">冲击</span>=外生(COVID)或政策 regime 突变(1980 Volcker、2022 通胀加息),leading 信号看不到、甚至反向(2022→0.17)。LOBO 用 embargo + 净基线(口径同 factorlab/model.py):留出该熊市训练其余、再看能否认出它,&gt;0.5 有效。hover「驱动机制」看成因。</div>`;
}

function tile(k, v, sub = "") {
  return `<div class="opt-tile"><div class="opt-k">${esc(k)}</div><div class="opt-v" style="font-size:13px">${esc(v)}</div>${sub ? `<div class="opt-sub">${esc(sub)}</div>` : ""}</div>`;
}

// 系数(特征)中文释义:16 宏观 + 7 市场技术,附在系数名后帮助解读
const COEF_CN = {
  term_10y3m: "期限利差 10Y−3M(倒挂=衰退前兆)",
  term_10y3m_long: "期限利差 10Y−3M(长窗平滑)",
  term_10y2y: "期限利差 10Y−2Y",
  credit_baa_aaa: "信用利差 Baa−Aaa(企业债风险溢价)",
  nfci: "NFCI 全国金融状况(>0=收紧)",
  vix: "VIX 波动率(恐慌情绪)",
  unrate: "失业率",
  sahm: "Sahm 衰退指标(失业率上行触发)",
  cfnai: "CFNAI 全国活动指数(<0=低于趋势)",
  claims: "初请失业金人数",
  cpi_yoy: "CPI 同比通胀",
  bm: "账面市值比 B/M(高=便宜)",
  ntis: "净股票发行率(高=供给过剩,看空)",
  gz_spread: "GZ 信用利差(企业债超额利差)",
  ebp: "超额债券溢价 EBP(升=避险)",
  est_prob: "基线先验概率",
  mkt_dd: "大盘回撤(距高点回落)",
  mkt_ret_1m: "近 1 月收益",
  mkt_mom_12m: "12 月动量",
  mkt_dist_10ma: "距 10 月均线偏离",
  mkt_rvol_3m: "近 3 月已实现波动",
  def_minus_cyc_12m: "防御−周期 12 月相对强弱(避险)",
  breadth_pct_above_10ma: "市场宽度(站上 10 月线个股占比)",
};

function coefBars(res) {
  const top = res.coef.slice(0, 14);
  const mx = Math.max(...top.map((c) => Math.abs(c[1]))) || 1;
  const rows = top.map(([f, c]) => {
    const w = Math.abs(c) / mx * 46, col = c >= 0 ? "var(--down)" : "var(--up)";
    const bar = c >= 0
      ? `<span style="display:inline-block;width:50%;text-align:right"></span><span style="display:inline-block;width:${w}%;height:10px;background:${col}"></span>`
      : `<span style="display:inline-block;width:${50 - w}%"></span><span style="display:inline-block;width:${w}%;height:10px;background:${col};float:right"></span>`;
    return `<div style="display:flex;align-items:center;gap:8px;margin:3px 0">
      <span style="width:210px;text-align:right;font-size:12px;line-height:1.25" class="muted"><span style="font-weight:600">${esc(f)}</span>${COEF_CN[f] ? `<br><span style="font-size:10px;opacity:.8">${esc(COEF_CN[f])}</span>` : ""}</span>
      <span style="flex:1">${bar}</span>
      <span style="width:52px;font-size:11px" class="${c >= 0 ? "down" : "up"}">${c >= 0 ? "+" : ""}${c.toFixed(2)}</span></div>`;
  }).join("");
  return `${rows}<div class="muted small" style="margin-top:6px">标准化系数:<span class="down">红=推高</span>预警 / <span class="up">绿=压低</span>。⚠️ 特征相关时个别系数符号可能翻转,别单独解读。</div>`;
}

/* ---------- Topic 1:熊/牛预测 ---------- */
async function renderBearbull() {
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

/* ---------- Topic 2:散户订单流 ---------- */
const fmtIC = (v) => v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(3);
const latest = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
const sgncls = (v) => v == null ? "" : (v > 0 ? "up" : "down");

// 预测信号(x)vs 实际收益(y)散点 + IC 标注
function scatterPredVsRealized(points, ic, ylab) {
  const W = 470, H = 250, pl = 46, pr = 12, pt = 14, pb = 30, iw = W - pl - pr, ih = H - pt - pb;
  if (!points || !points.length) return `<div class="muted small" style="padding:20px">${esc(ylab)}:暂无已兑现样本(前瞻窗口未到期)</div>`;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  const sx = (v) => pl + (xmax === xmin ? 0.5 : (v - xmin) / (xmax - xmin)) * iw;
  const sy = (v) => pt + (1 - (ymax === ymin ? 0.5 : (v - ymin) / (ymax - ymin))) * ih;
  const dots = points.map((p) => `<circle cx="${sx(p[0]).toFixed(1)}" cy="${sy(p[1]).toFixed(1)}" r="2.6" fill="var(--accent)" opacity="0.5"><title>${esc(p[2])} 信号 ${p[0].toFixed(2)} → ${(p[1] * 100).toFixed(2)}%</title></circle>`).join("");
  const z0y = (ymin < 0 && ymax > 0) ? `<line x1="${pl}" y1="${sy(0).toFixed(1)}" x2="${pl + iw}" y2="${sy(0).toFixed(1)}" stroke="var(--border)"/>` : "";
  const z0x = (xmin < 0 && xmax > 0) ? `<line x1="${sx(0).toFixed(1)}" y1="${pt}" x2="${sx(0).toFixed(1)}" y2="${pt + ih}" stroke="var(--border)"/>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px">
    <rect x="${pl}" y="${pt}" width="${iw}" height="${ih}" fill="none" stroke="var(--border)"/>
    ${z0y}${z0x}${dots}
    <text x="${pl + iw / 2}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--muted)">预测信号(z 之积)</text>
    <text x="12" y="${pt + ih / 2}" text-anchor="middle" font-size="10" fill="var(--muted)" transform="rotate(-90 12 ${pt + ih / 2})">${esc(ylab)}</text>
    <text x="${pl + iw - 4}" y="${pt + 12}" text-anchor="end" font-size="11" fill="var(--accent)">IC ${fmtIC(ic)} · n=${points.length}</text>
  </svg>`;
}

// 散户净买入热力图(票 × 日)
function netbuyHeatmap(J) {
  const d = J.dates, tks = J.tickers, D = J.data;
  const cell = (v) => {
    if (v == null) return `<td style="padding:0;width:13px"></td>`;
    const a = Math.min(1, Math.abs(v) / 0.3), c = v > 0 ? `rgba(52,211,153,${a})` : `rgba(248,113,113,${a})`;
    return `<td style="padding:0;width:13px;background:${c}" title="${(v > 0 ? "+" : "") + v.toFixed(3)}"></td>`;
  };
  const head = `<tr><th></th>${d.map((x) => `<th style="font-size:8px;font-weight:400;color:var(--muted)">${x.slice(5).replace("-", "/")}</th>`).join("")}</tr>`;
  const rows = tks.map((tk) => `<tr><td style="font-size:11px">${esc(tk)}</td>${d.map((_, i) => cell(D[tk].netbuy[i])).join("")}</tr>`).join("");
  return `<div style="overflow-x:auto"><table class="bt-table" style="border-spacing:1px">${head}${rows}</table></div>
    <div class="muted small" style="margin-top:6px">每格=某票某日散户净买入(<span class="up">绿=净买</span>/<span class="down">红=净卖</span>,深浅随 |值|,饱和于 0.3)。</div>`;
}

/* 散户流跑批标的多选器:写回 config/retail_syms.json(独立于 D/Q)。下次跑批生效。 */
async function saveRetailSyms(symbols) {
  const pat = getPat();
  if (!pat) return { ok: false, msg: "需要 fine-grained PAT(与交易台采集面板共用,存本机)" };
  const url = `https://api.github.com/repos/${REPO}/contents/config/retail_syms.json`;
  let sha;
  try {
    const cur = await fetch(url + "?ref=main", { headers: ghHeaders(pat) });
    if (cur.ok) sha = (await cur.json()).sha;
  } catch { /* 新建 */ }
  const body = { _note: "散户订单流引擎跑哪些票(独立于 D/Q;research 页多选下拉编辑)。逐笔成本 ~2-15min/票。", symbols };
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(body, null, 2) + "\n")));
  try {
    const r = await fetch(url, { method: "PUT", headers: ghHeaders(pat),
      body: JSON.stringify({ message: "chore: update retail_syms via research UI", content, sha, branch: "main" }) });
    return r.ok ? { ok: true } : { ok: false, msg: "PUT 失败 " + r.status };
  } catch (e) { return { ok: false, msg: String(e) }; }
}

async function renderPicker() {
  const el = $("rf-picker"); if (!el) return;
  const [cfg, rs] = await Promise.all([loadJSON("config/tickers.json"), loadJSON("config/retail_syms.json")]);
  const wl = (cfg && cfg.watchlist) || [];
  const sel = new Set(((rs && rs.symbols) || []).map((s) => s.toUpperCase()));
  const label = (arr) => `⚙️ 跑批标的:${arr.length ? arr.join(", ") : "（无）"} (${arr.length}) — 点开选择`;
  const chips = wl.map((t) => `<label class="rf-chip" style="display:inline-flex;align-items:center;gap:4px;font-size:12px">
      <input type="checkbox" value="${esc(t)}"${sel.has(t.toUpperCase()) ? " checked" : ""}> ${esc(t)}</label>`).join("");
  el.innerHTML = `<details>
    <summary id="rf-pick-sum" style="cursor:pointer;font-weight:600">${esc(label([...sel]))}</summary>
    <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px 14px">${chips}</div>
    <div style="margin-top:10px;display:flex;align-items:center;gap:10px">
      <button id="rf-save" class="tab">保存到 config/retail_syms.json</button>
      <span id="rf-save-msg" class="muted small"></span>
    </div>
    <div class="muted small" style="margin-top:6px">改动写回仓库 config,<b>下次跑批(每日 cron / 手动)生效</b>,不影响已采集历史。逐笔 ~2-15min/票,别选太多。需 fine-grained PAT(Contents 读写)。</div>
  </details>`;
  const checked = () => [...el.querySelectorAll("input:checked")].map((i) => i.value.toUpperCase());
  el.querySelectorAll("input[type=checkbox]").forEach((cb) => cb.addEventListener("change",
    () => { $("rf-pick-sum").textContent = label(checked()); }));
  $("rf-save").addEventListener("click", async () => {
    const msg = $("rf-save-msg"); msg.textContent = "保存中…";
    const r = await saveRetailSyms(checked());
    msg.textContent = r.ok ? "✓ 已保存,下次跑批生效" : "✗ " + r.msg;
  });
}

async function renderRetailflow() {
  renderPicker();
  const J = await loadJSON("data/retailflow.json");
  const set = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
  if (!J) {
    $("r-status").textContent = "Topic: 散户订单流 · 缺 data/retailflow.json(在 Actions 跑 retailflow 工作流生成)";
    ["rf-now", "rf-scatter", "rf-ic", "rf-series"].forEach((id) => set(id, `<span class="muted small">暂无数据:需在 Actions 跑 fetch_tick_flow + build_retailflow 生成 data/retailflow.json</span>`));
    return;
  }
  const d = J.dates, tks = J.tickers, D = J.data, E = J.eval;
  $("r-status").textContent = `Topic: 散户订单流 · ${d[0]}→${d[d.length - 1]} · ${tks.length} 票 × ${d.length} 天(${J.window_days || 30}d 滚动)· 更新 ${(J.updated || "").slice(0, 16)}`;

  // ① 当前信号表
  const rows = tks.map((tk) => {
    const o = D[tk], nb = latest(o.netbuy), it = latest(o.intensity), at = o.attention ? latest(o.attention) : null, sg = latest(o.signal);
    const p = (E.per_ticker || {})[tk] || {};
    return `<tr><td>${esc(tk)}</td>
      <td class="${sgncls(nb)}">${nb == null ? "—" : (nb > 0 ? "+" : "") + nb.toFixed(3)}</td>
      <td>${it == null ? "—" : (it * 100).toFixed(1) + "%"}</td>
      <td>${at == null ? "—" : at.toFixed(0)}</td>
      <td class="${sgncls(sg)}">${sg == null ? "—" : (sg > 0 ? "+" : "") + sg.toFixed(2)}</td>
      <td class="${sgncls(p.ic_1d)}">${fmtIC(p.ic_1d)}</td>
      <td class="${sgncls(p.ic_5d)}">${fmtIC(p.ic_5d)}</td></tr>`;
  }).join("");
  set("rf-now", `<table class="bt-table"><tr><th>票</th><th>净买入</th><th>强度</th><th>关注</th><th>复合信号</th><th>IC次日</th><th>IC次周</th></tr>${rows}</table>
    <div class="muted small">最新交易日值。净买入∈[-1,1](中点签名的场外散户买卖不平衡);强度=散户量/总量;关注=Google Trends;复合=三项时序 z 之积。逐票 IC=该票信号对前瞻收益的秩相关。</div>`);

  // ② 散点:预测 vs 实际
  set("rf-scatter", `<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start">
      <div>${scatterPredVsRealized(E.scatter_1d, E.ic_1d, "次日实际收益")}</div>
      <div>${scatterPredVsRealized(E.scatter_5d, E.ic_5d, "次周实际收益")}</div></div>
    <div class="muted small">每点=某票某日:x=当日复合信号,y=之后实际收益。正斜率=信号有预测力。散户流常在极端处反向(聪明钱反做)。</div>`);

  // ③ 预测力 IC
  set("rf-ic", `<div class="opt-grid">
      ${tile("IC 次日 · 复合", fmtIC(E.ic_1d), `n=${E.n_obs_1d}`)}
      ${tile("IC 次周 · 复合", fmtIC(E.ic_5d), `n=${E.n_obs_5d}`)}
      ${tile("IC 次日 · 仅净买入", fmtIC(E.ic_netbuy_1d), "对照:去掉强度/关注")}
      ${tile("IC 次周 · 仅净买入", fmtIC(E.ic_netbuy_5d), "对照")}
    </div>
    <div class="muted small">${(J.meta && J.meta.caveats || []).map(esc).join(" · ")}</div>`);

  // ④ 净买入热力图
  set("rf-series", netbuyHeatmap(J));
}

/* Topic 3:国债 vs 股市 — 左轴=SPY/QQQ/IWM 归一100,右轴(虚线)=US 2/10/30Y 收益率%。
   研究国债收益率对股市的影响(自 strategy 页迁移)。lightweight-charts(与 trading K 线同框架):
   点击图例开关任意曲线;悬停显示该日所有已展示曲线的值。 */
async function renderRates() {
  const el = $("rates-chart"); if (!el) return;
  const LWC = window.LightweightCharts;
  if (!LWC) { el.innerHTML = '<span class="muted small">图表库未加载</span>'; return; }
  const r = await loadJSON("data/rates.json");
  if (!r || !r.series) { el.innerHTML = '<span class="muted small">缺 data/rates.json</span>'; return; }
  const meta = r.meta || {};
  el.innerHTML = "";
  const chart = LWC.createChart(el, {
    layout: { background: { color: "transparent" }, textColor: "#8b96ad" },
    grid: { vertLines: { color: "#1e2941" }, horzLines: { color: "#1e2941" } },
    leftPriceScale: { visible: true, borderColor: "#2a3550" },
    rightPriceScale: { visible: true, borderColor: "#2a3550" },
    timeScale: { borderColor: "#2a3550" },
    crosshair: { mode: LWC.CrosshairMode.Normal },
    height: 380,
  });
  const toLine = (arr) => {
    const seen = new Set(), out = [];
    for (const [d, v] of arr) if (!seen.has(d)) { seen.add(d); out.push({ time: d, value: v }); }
    return out;
  };
  const S = [];                                     // 每条曲线:{label,color,isYield,series,visible,latest,fmt}
  for (const [key, arr] of Object.entries(r.series)) {
    if (!arr || !arr.length) continue;
    const m = meta[key] || {}, isYield = m.axis === "yield";
    const color = m.color || "#60a5fa", label = m.label || key;
    let data, latest, fmt;
    if (isYield) {
      data = toLine(arr);
      latest = arr[arr.length - 1][1].toFixed(2) + "%";
      fmt = (v) => v.toFixed(2) + "%";
    } else {
      const base = arr[0][1] || 1;
      data = toLine(arr.map(([d, v]) => [d, v / base * 100]));   // 归一到 100
      const chg = (arr[arr.length - 1][1] / base - 1) * 100;
      latest = (chg >= 0 ? "+" : "") + chg.toFixed(0) + "%";
      fmt = (v) => (v >= 100 ? "+" : "") + (v - 100).toFixed(0) + "%";   // 归一值→自起点涨跌%
    }
    const series = chart.addLineSeries({
      color, lineWidth: 2,
      lineStyle: isYield ? LWC.LineStyle.Dashed : LWC.LineStyle.Solid,
      priceScaleId: isYield ? "right" : "left",
      priceLineVisible: false, lastValueVisible: false,
    });
    series.setData(data);
    S.push({ label, color, isYield, series, visible: true, latest, fmt });
  }
  chart.timeScale().fitContent();

  // 可点图例:点 label 开关曲线
  const leg = $("rates-legend");
  if (leg) {
    leg.innerHTML = "";
    S.forEach((s) => {
      const chip = document.createElement("span");
      chip.className = "rt-leg";
      chip.innerHTML = `<span class="rt-sw" style="background:${s.color}"></span>${esc(s.label)} <b>${s.latest}</b>`;
      chip.onclick = () => {
        s.visible = !s.visible;
        s.series.applyOptions({ visible: s.visible });
        chip.classList.toggle("off", !s.visible);
      };
      leg.appendChild(chip);
    });
  }

  // 悬停浮层:该日所有"已展示"曲线的值
  const hov = $("rates-hover");
  if (hov) {
    chart.subscribeCrosshairMove((param) => {
      if (!param.point || !param.time) { hov.style.display = "none"; return; }
      const rows = [];
      for (const s of S) {
        if (!s.visible) continue;
        const d = param.seriesData.get(s.series);
        if (!d || d.value == null) continue;
        rows.push(`<span style="color:${s.color}">● ${esc(s.label)} ${s.fmt(d.value)}</span>`);
      }
      if (!rows.length) { hov.style.display = "none"; return; }
      hov.innerHTML = `<div class="muted" style="margin-bottom:2px">${param.time}</div>` + rows.join("<br>");
      hov.style.display = "block";
    });
  }
}

/* Topic 4:净 GEX → 次日已实现波动(自 strategy 页迁入)。读 data/strategy_bt.json 的 study 字段。
   纯预测力研究(无持仓/成本)→ 属 research。 */
async function renderGexVol() {
  const host = $("gx-study"); if (!host) return;
  const d = await loadJSON("data/strategy_bt.json");
  const s = d && d.study;
  if (!s || s.insufficient) { host.innerHTML = '<span class="muted small">暂无研究数据(data/strategy_bt.json 的 study 字段)</span>'; return; }
  const sub = $("gx-sub"); if (sub) sub.textContent = `${s.n} 天 · ${s.start}→${s.end}`;
  const T = (k, v, sb = "", cls = "") =>
    `<div class="opt-tile"><div class="opt-k">${esc(k)}</div><div class="opt-v ${cls}">${esc(v)}${sb ? ` <span class="opt-sub">${esc(sb)}</span>` : ""}</div></div>`;
  const num = (v, dg = 2) => (v == null ? "—" : (+v).toFixed(dg));
  const rg = s.regime || {}, ic = s.incr || {};
  const q = s.quintiles_pct || [], qmax = Math.max(...q, 0.001);
  const bars = q.map((v, i) =>
    `<div style="display:flex;flex-direction:column;align-items:center;gap:3px">
       <div style="font-size:10px;color:var(--muted)">${v}%</div>
       <div style="width:34px;height:${Math.round(v / qmax * 90)}px;background:var(--accent);border-radius:3px 3px 0 0"></div>
       <div style="font-size:10px;color:var(--muted)">Q${i + 1}</div>
     </div>`).join("");
  host.innerHTML =
    `<div class="wb-statbar">${[
      T("GEX<0 vs >0 次日波动", (rg.ratio ?? "—") + "×", `${rg.neg_mean_pct}% / ${rg.pos_mean_pct}%`, "down"),
      T("Spearman", num(s.spearman, 3), `CI [${(s.spearman_ci || []).join(", ")}]`, "down"),
      T("增量 ΔR²", "+" + num((ic.delta_r2 ?? 0) * 100, 2) + "%", "控制|r_t|后", "up"),
      T("子期", (s.subperiods || []).map((p) => `${p.label} ${p.spearman}`).join(" · ")),
    ].join("")}</div>
     <div style="display:flex;gap:14px;align-items:flex-end;margin:14px 0 4px;height:120px">${bars}</div>
     <div class="muted small">${esc(s.label || "净 GEX → 次日已实现波动")}:按 GEX 五分位分组的次日 |r|——低 GEX(Q1)→ 高波动,高 GEX(Q5)→ 低波动(单调,符合 dealer-gamma 抑制/放大机制)。纯预测力研究(无持仓/成本)。</div>`;
}

/* ---------- Tab 调度 ---------- */
const RENDER = { bearbull: renderBearbull, retailflow: renderRetailflow, rates: renderRates, gexvol: renderGexVol };
const rendered = {};
async function showTopic(topic) {
  if (!RENDER[topic]) return;
  document.querySelectorAll(".tab[data-topic]").forEach((t) => t.classList.toggle("active", t.dataset.topic === topic));
  document.querySelectorAll("[data-topic-panel]").forEach((s) => { s.hidden = s.dataset.topicPanel !== topic; });
  if (!rendered[topic]) { rendered[topic] = true; try { await RENDER[topic](); } catch (e) { console.error(e); } }
}
document.querySelectorAll(".tab[data-topic]").forEach((t) => {
  if (!RENDER[t.dataset.topic]) return;             // deadtime 等未实现的保持禁用
  t.style.cursor = "pointer";
  t.addEventListener("click", () => showTopic(t.dataset.topic));
});
showTopic("bearbull");
