#!/usr/bin/env python3
"""预注册式信号研究:净 GEX → 次日已实现波动(纯 stdlib,本地研究脚本,不 commit)。

**问题**:净 GEX 越高(dealer 越多头 gamma)是否预示**次日波动越低**;GEX<0(空 gamma)是否放大波动。
这是机制对口的因变量(波动,不是涨跌),已在 SPX 上验证通过——见文末。

**预注册口径(结论前冻结)**:
- 自变量 = GEX_t;因变量 = |r_(t+1)|(次日绝对收益,单日已实现波动代理);控制 = |r_t|(波动持续性)。
- H1:GEX_t 与 |r_(t+1)| **负相关**(高 GEX→低波动)。
- 检验:①区制(GEX<0 vs >0 的次日波动,免疫尺度/趋势)②Spearman + block-bootstrap CI
  ③增量 R²(控制 |r_t| 后 GEX 是否还有用)④五分位单调性 ⑤子期稳定性。

**用法**:
    python3 scripts/research_gex_vol.py                 # 默认拉 SqueezeMetrics SPX 免费 CSV
    python3 scripts/research_gex_vol.py path/to.csv     # 或读本地 CSV(列: date,price,gex[,dix])
**复用到单名股**:把你的 (dates, price, gex) 三列喂给 study(),口径完全一样。
"""
import csv
import math
import random
import statistics as st
import sys
import urllib.request

random.seed(0)
SQZ_URL = "https://squeezemetrics.com/monitor/static/DIX.csv"


def load_csv(path_or_none):
    if path_or_none:
        rows = list(csv.DictReader(open(path_or_none)))
    else:
        with urllib.request.urlopen(SQZ_URL, timeout=30) as r:
            rows = list(csv.DictReader(l.decode() for l in r))
    rows = [r for r in rows if r.get("gex") and r.get("price")]
    rows.sort(key=lambda r: r["date"])
    return [r["date"] for r in rows], [float(r["price"]) for r in rows], [float(r["gex"]) for r in rows]


def _ranks(a):
    idx = sorted(range(len(a)), key=lambda i: a[i]); r = [0.0] * len(a); i = 0
    while i < len(a):
        j = i
        while j + 1 < len(a) and a[idx[j + 1]] == a[idx[i]]:
            j += 1
        for k in range(i, j + 1):
            r[idx[k]] = (i + j) / 2 + 1
        i = j + 1
    return r


def _pear(a, b):
    ma, mb = st.fmean(a), st.fmean(b)
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    da = math.sqrt(sum((x - ma) ** 2 for x in a)); db = math.sqrt(sum((y - mb) ** 2 for y in b))
    return num / (da * db) if da and db else 0.0


def spearman(a, b):
    return _pear(_ranks(a), _ranks(b))


def _boot_spear(a, b, block=20, iters=2000):
    m = len(a); nb = m // block; out = []
    for _ in range(iters):
        ia = []
        for _ in range(nb):
            s = random.randint(0, m - block); ia += range(s, s + block)
        out.append(spearman([a[i] for i in ia], [b[i] for i in ia]))
    out.sort()
    return out[int(.025 * iters)], out[int(.975 * iters)]


def _ols(y, X):  # 高斯消元最小二乘,返回 (系数, R²)
    k = len(X[0])
    A = [[sum(X[r][i] * X[r][j] for r in range(len(X))) for j in range(k)] + [sum(X[r][i] * y[r] for r in range(len(X)))] for i in range(k)]
    for c in range(k):
        p = max(range(c, k), key=lambda r: abs(A[r][c])); A[c], A[p] = A[p], A[c]
        for r in range(k):
            if r != c and A[c][c]:
                f = A[r][c] / A[c][c]; A[r] = [A[r][j] - f * A[c][j] for j in range(k + 1)]
    b = [A[i][k] / A[i][i] for i in range(k)]
    yh = [sum(b[i] * X[r][i] for i in range(k)) for r in range(len(X))]
    my = st.fmean(y); ss = sum((v - my) ** 2 for v in y); rss = sum((y[r] - yh[r]) ** 2 for r in range(len(y)))
    return b, 1 - rss / ss


def study(dates, price, gex, label="series") -> dict:
    """返回研究结果 dict(不打印;样本不足返回 {"insufficient":True})。口径见文件头预注册。"""
    n = len(price)
    absr = [None] + [abs(price[i] / price[i - 1] - 1) for i in range(1, n)]
    T = [t for t in range(1, n - 1) if absr[t] is not None and absr[t + 1] is not None]
    G = [gex[t] for t in T]; Y = [absr[t + 1] for t in T]; V = [absr[t] for t in T]; D = [dates[t] for t in T]
    if len(T) < 30:
        return {"label": label, "n": len(T), "insufficient": True}
    neg = [Y[i] for i in range(len(G)) if G[i] < 0]; pos = [Y[i] for i in range(len(G)) if G[i] >= 0]
    s = spearman(G, Y); lo, hi = _boot_spear(G, Y); sc = spearman(G, V)
    mg, sg = st.fmean(G), st.pstdev(G) or 1.0; Z = [(g - mg) / sg for g in G]
    _, r1 = _ols(Y, [[1, v] for v in V]); b2, r2 = _ols(Y, [[1, v, z] for v, z in zip(V, Z)])
    order = sorted(range(len(G)), key=lambda i: G[i]); q = len(order) // 5
    quint = [round(st.fmean([Y[i] for i in (order[k * q:(k + 1) * q] if k < 4 else order[4 * q:])]) * 100, 3) for k in range(5)]
    subs = []
    for lab, cond in [("<2020", lambda d: d < "2020-01-01"), (">=2020", lambda d: d >= "2020-01-01")]:
        ix = [i for i in range(len(D)) if cond(D[i])]
        if len(ix) > 30:
            subs.append({"label": lab, "spearman": round(spearman([G[i] for i in ix], [Y[i] for i in ix]), 3), "n": len(ix)})
    return {
        "label": label, "n": len(T), "start": D[0], "end": D[-1], "neg_days": len(neg), "pos_days": len(pos),
        "regime": {"neg_mean_pct": round(st.fmean(neg) * 100, 3) if neg else None,
                   "pos_mean_pct": round(st.fmean(pos) * 100, 3) if pos else None,
                   "ratio": round(st.fmean(neg) / st.fmean(pos), 2) if neg and pos else None},
        "spearman": round(s, 3), "spearman_ci": [round(lo, 3), round(hi, 3)], "spearman_contemp": round(sc, 3),
        "incr": {"r2_base": round(r1, 4), "r2_full": round(r2, 4), "delta_r2": round(r2 - r1, 4), "beta_gex": round(b2[2], 5)},
        "quintiles_pct": quint, "subperiods": subs,
    }


def report(res: dict) -> None:
    if not res or res.get("insufficient"):
        print(f"{res.get('label')}: 样本不足({res.get('n')})"); return
    rg = res["regime"]; i = res["incr"]
    print(f"== {res['label']} ==  {res['n']} 天  {res['start']}→{res['end']}  (GEX 负{res['neg_days']}/正{res['pos_days']})")
    print(f"[1] 区制 次日|r|: GEX<0 {rg['neg_mean_pct']}%  GEX>0 {rg['pos_mean_pct']}%  比值 {rg['ratio']}x")
    print(f"[2] Spearman {res['spearman']:+}  95%CI {res['spearman_ci']}  (同日 {res['spearman_contemp']:+})")
    print(f"[3] R² {i['r2_base']}→{i['r2_full']}  ΔR² {i['delta_r2']:+}  β_GEX {i['beta_gex']:+}")
    print(f"[4] 五分位(低→高,应递减) {res['quintiles_pct']}")
    print(f"[5] 子期 {res['subperiods']}")


if __name__ == "__main__":
    dates, price, gex = load_csv(sys.argv[1] if len(sys.argv) > 1 else None)
    report(study(dates, price, gex, label="SPX (SqueezeMetrics)"))
