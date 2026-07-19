#!/usr/bin/env python3
"""前向记录器的评测:读 data/flow_history.json(由 fetch_research 每轮累积),
用**真实 flow-GEX**(带 gamma×OI)跑与 docs/backtest-flow-gamma-pilot.md 同一套预注册检验:
条件自相关交互(空γ→延续 vs 多γ→回归)、30min 网格、大盘去均值、分层与逐日一致性。

纯 stdlib、只读、无需 API/key。flow_history 在 data 分支:
  git fetch origin data && git show origin/data:data/flow_history.json > data/flow_history.json
env: EVAL_FILE(默认 data/flow_history.json)· GRID_MIN(默认 30)
"""
import bisect
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILE = os.environ.get("EVAL_FILE", str(ROOT / "data" / "flow_history.json"))
GRID_MIN = int(os.environ.get("GRID_MIN", "30"))
RTH_OPEN_H, RTH_CLOSE_H = 13.5, 20.0    # 夏令时 UTC;冬令时数据到时再按月分段


def epoch(t_iso):
    return datetime.fromisoformat(t_iso).timestamp()


def pearson(xs, ys):
    n = len(xs)
    if n < 5:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return sxy / math.sqrt(sxx * syy) if sxx > 0 and syy > 0 else None


def fmt(x):
    return "n/a" if x is None else f"{x:+.3f}"


def main():
    pts = json.loads(Path(FILE).read_text()).get("points", [])
    # 按票分组的 (epoch, spot, fn) 序列;只留有 flow 的单名股、RTH 内
    byh = defaultdict(list)
    for p in pts:
        if p.get("fn") is None or p.get("p") is None:
            continue
        e = epoch(p["t"])
        h = datetime.fromtimestamp(e, timezone.utc)
        hourf = h.hour + h.minute / 60.0
        if not (RTH_OPEN_H <= hourf <= RTH_CLOSE_H):
            continue
        byh[p["s"]].append((e, p["p"], p["fn"], p["t"][:10]))
    for s in byh:
        byh[s].sort()

    g = GRID_MIN * 60
    # 每票在 30min 网格上取观测:S=区制符号(fn<0=空γ→预测延续),r_past/r_fwd 由 spot 序列取
    obs = []   # (day, slot, sym, S, r_past, r_fwd)
    for sym, seq in byh.items():
        es = [x[0] for x in seq]

        def price_at(t):
            i = bisect.bisect_left(es, t)
            # 取最近的记录点(容差 GRID_MIN/2)
            best = None
            for j in (i - 1, i):
                if 0 <= j < len(seq) and abs(seq[j][0] - t) <= g / 2:
                    if best is None or abs(seq[j][0] - t) < abs(seq[best][0] - t):
                        best = j
            return seq[best][1] if best is not None else None

        def fn_at(t):
            i = bisect.bisect_right(es, t) - 1
            return seq[i][2] if i >= 0 else None

        days = sorted(set(x[3] for x in seq))
        for day in days:
            d0 = datetime.fromisoformat(day + "T00:00:00+00:00").timestamp()
            t = d0 + (RTH_OPEN_H + GRID_MIN / 60) * 3600
            while t <= d0 + (RTH_CLOSE_H - GRID_MIN / 60) * 3600 + 1:
                p0, pm, pp = price_at(t - g), price_at(t), price_at(t + g)
                fn = fn_at(t)
                if p0 and pm and pp and p0 > 0 and pm > 0 and fn is not None and fn != 0:
                    S = -1 if fn > 0 else 1          # fn<0=空γ→预测延续→归入 S>0 组(同 pilot 约定)
                    obs.append((day, int((t - d0) // g), sym,
                                S, math.log(pm / p0), math.log(pp / pm)))
                t += g

    if len(obs) < 30:
        print(f"样本不足({len(obs)});前向记录器需继续累积(目标 ≥30-40 交易日)。文件 {FILE}")
        return

    # 大盘去均值:每 (day, slot) 横截面对 r_fwd 去均值
    gm = defaultdict(list)
    for i, o in enumerate(obs):
        gm[(o[0], o[1])].append(i)
    rfwd = [o[5] for o in obs]
    for idxs in gm.values():
        m = sum(rfwd[i] for i in idxs) / len(idxs)
        for i in idxs:
            rfwd[i] = obs[i][5] - m

    S = [o[3] for o in obs]
    rpast = [o[4] for o in obs]
    up = [(rpast[i], rfwd[i]) for i in range(len(obs)) if S[i] > 0]
    dn = [(rpast[i], rfwd[i]) for i in range(len(obs)) if S[i] < 0]
    base = pearson(rpast, rfwd)
    c_up = pearson([x[0] for x in up], [x[1] for x in up])
    c_dn = pearson([x[0] for x in dn], [x[1] for x in dn])
    inter = pearson([S[i] * rpast[i] for i in range(len(obs))], rfwd)
    diff = (c_up - c_dn) if (c_up is not None and c_dn is not None) else None
    days = sorted(set(o[0] for o in obs))
    cons = 0
    for d in days:
        dr = [i for i in range(len(obs)) if obs[i][0] == d]
        u = [(rpast[i], rfwd[i]) for i in dr if S[i] > 0]
        v = [(rpast[i], rfwd[i]) for i in dr if S[i] < 0]
        cu = pearson([x[0] for x in u], [x[1] for x in u]) if len(u) >= 5 else None
        cv = pearson([x[0] for x in v], [x[1] for x in v]) if len(v) >= 5 else None
        if cu is not None and cv is not None and cu - cv > 0:
            cons += 1

    print(f"===== 真实 flow-GEX 前向评测 · 观测 {len(obs)} · 票 {len(byh)} · 天 {len(days)} =====")
    print(f"  空γ {len(up)} / 多γ {len(dn)}")
    print(f"  无条件自相关 = {fmt(base)}")
    print(f"  空γ组 corr₊ = {fmt(c_up)}   多γ组 corr₋ = {fmt(c_dn)}")
    print(f"  判定量 corr₊−corr₋ = {fmt(diff)}   (预注册:>0 且 ≥0.05)")
    print(f"  交互 corr(S·r_past, r_fwd) = {fmt(inter)}   (预注册:>0)")
    print(f"  逐日 corr₊−corr₋>0: {cons}/{len(days)}   (预注册:≥4/5;正式结论待 ≥30-40 交易日 + 显著性)")


if __name__ == "__main__":
    main()
