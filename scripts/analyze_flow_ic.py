#!/usr/bin/env python3
"""期权流 → 方向:横截面 rank-IC 研究(读 data/gex_daily.json,纯计算不抓网)。

问题:逐票的期权定价/流向变量,对**后续收益**有没有横截面预测力?
预测变量(v1,三个):
  net_flow  净签名期权流,按 |dealer gamma notional| 归一(去规模)= 方向强度。预期 +(看多流→涨)
  vrp       方差风险溢价 IV−RV。预期 −(保护贵→均值回归/低回报)
  skew_rr   风险反转(call−put IV)。预期 +(偏多定价→涨)
口径(和散户流/scorecard 同源、诚实):
  - 用**秩**、单变量、不拟合(防过拟合);横截面 Spearman IC。
  - **entry_lag=1 无前视**:net_flow 在当日盘后(~20:00)才知道 → 只能次日进场,
    故前瞻收益从 d+1 起算(r_H = spot_{d+1+H}/spot_{d+1} − 1),IC 与回测一致。
  - 重叠窗口(H>1)→ 用 moving-block bootstrap 给 mean IC 的 CI(非 naive std)。
  - net_flow 额外:①按 dealer gamma 正负分层(空γ 追涨→动量 / 多γ 抑制→反转);
    ②扣成本 L/S 五档回测(H=1,日频)—— 展示"可预测≠可盈利"。
样本极小(~35 票 × ~54 交易日,且日采集在长),结论会标"样本不足";引擎现在建、边跑边攒。
输出 data/flow_ic.json。非投资建议。"""
import json
import math
import random
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "gex_daily.json"
OUT = ROOT / "data" / "flow_ic.json"

HORIZONS = [1, 5, 21]
LAG = 1                 # 无前视:信号 d(盘后)→ d+1 进场
MIN_NAMES = 8          # 单日横截面至少这么多票才算 IC
MIN_EFF = 4.0          # 有效独立样本(n_days/H)低于此 → 样本不足
COST_BPS = 3.0         # L/S 回测每边成本(bp)
B, BLOCK = 800, 5      # bootstrap


def _spearman(xs, ys):
    """Spearman(平均秩处理并列);样本<3 或无方差 → None。"""
    n = len(xs)
    if n < 3:
        return None

    def ranks(v):
        order = sorted(range(n), key=lambda i: v[i])
        r = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j + 1 < n and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2.0 + 1.0
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r

    rx, ry = ranks(xs), ranks(ys)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((rx[i] - mx) * (ry[i] - my) for i in range(n))
    dx = math.sqrt(sum((rx[i] - mx) ** 2 for i in range(n)))
    dy = math.sqrt(sum((ry[i] - my) ** 2 for i in range(n)))
    return num / (dx * dy) if dx and dy else None


def _mbb_mean_ci(series, rng):
    """moving-block bootstrap 的 mean CI([2.5,97.5]);处理重叠自相关。"""
    n = len(series)
    if n < 3:
        return None
    means = []
    nb = math.ceil(n / BLOCK)
    for _ in range(B):
        idx = []
        for _ in range(nb):
            s = rng.randrange(0, max(1, n - BLOCK + 1))
            idx.extend(range(s, min(s + BLOCK, n)))
        idx = idx[:n]
        means.append(sum(series[i] for i in idx) / n)
    means.sort()
    return [round(means[int(0.025 * B)], 4), round(means[int(0.975 * B)], 4)]


def ic_stats(ic_series, horizon, rng):
    n = len(ic_series)
    n_eff = n / horizon
    if n < 3 or n_eff < MIN_EFF:
        return {"n_days": n, "n_eff": round(n_eff, 1), "status": "insufficient"}
    mean = sum(ic_series) / n
    var = sum((x - mean) ** 2 for x in ic_series) / (n - 1)
    std = math.sqrt(var)
    ci = _mbb_mean_ci(ic_series, rng)
    return {"n_days": n, "n_eff": round(n_eff, 1), "status": "ok",
            "mean_ic": round(mean, 4), "ir": round(mean / std, 3) if std else None,
            "ci": ci, "sig": bool(ci and (ci[0] > 0 or ci[1] < 0))}


def main():
    if not SRC.exists():
        OUT.write_text(json.dumps({"error": "缺 data/gex_daily.json"}, ensure_ascii=False))
        print("缺 gex_daily.json"); return
    gd = json.loads(SRC.read_text())
    dates = sorted(gd.keys())
    rng = random.Random(42)

    # 预取:每票的 spot 序列(按 dates 顺序)→ 前瞻收益;及每(日,票)预测变量
    def spot(d, s):
        r = gd.get(d, {}).get(s) or {}
        return r.get("spot")

    def fwd_ret(i, s, h):
        """entry_lag=1:从 dates[i+LAG] 到 dates[i+LAG+h] 的收益。"""
        j0, j1 = i + LAG, i + LAG + h
        if j1 >= len(dates):
            return None
        p0, p1 = spot(dates[j0], s), spot(dates[j1], s)
        return (p1 / p0 - 1.0) if (p0 and p1 and p0 > 0) else None

    def netflow_norm(rec, day_floor):
        nf, nn = rec.get("net_flow"), rec.get("net_nom")
        if nf is None or nn is None:
            return None
        return nf / max(abs(nn), day_floor)

    PREDS = {
        "net_flow": {"expected_sign": 1, "desc": "净签名期权流 / |dealer gamma|(方向)"},
        "vrp": {"expected_sign": -1, "desc": "方差风险溢价 IV−RV(保护贵→均值回归)"},
        "skew_rr": {"expected_sign": 1, "desc": "风险反转 call−put IV(偏多定价)"},
    }
    # 每个预测变量 × horizon 的每日 IC 序列
    ic = {p: {h: [] for h in HORIZONS} for p in PREDS}
    ic_gamma = {"short": {h: [] for h in HORIZONS}, "long": {h: [] for h in HORIZONS}}  # net_flow 分层

    for i, d in enumerate(dates):
        day = gd[d]
        nn_abs = [abs(r["net_nom"]) for r in day.values() if r.get("net_nom") is not None]
        floor = 0.2 * (sorted(nn_abs)[len(nn_abs) // 2] if nn_abs else 1.0) or 1.0
        for h in HORIZONS:
            # 收集本日 (预测变量, 前瞻收益) 对
            rows = {p: ([], []) for p in PREDS}
            g_rows = {"short": ([], []), "long": ([], [])}
            for s, rec in day.items():
                fr = fwd_ret(i, s, h)
                if fr is None:
                    continue
                vals = {"net_flow": netflow_norm(rec, floor), "vrp": rec.get("vrp"), "skew_rr": rec.get("skew_rr")}
                for p in PREDS:
                    if vals[p] is not None:
                        rows[p][0].append(vals[p]); rows[p][1].append(fr)
                # gamma 分层(仅 net_flow)
                nf, nn = vals["net_flow"], rec.get("net_nom")
                if nf is not None and nn is not None:
                    g = "short" if nn < 0 else "long"
                    g_rows[g][0].append(nf); g_rows[g][1].append(fr)
            for p in PREDS:
                if len(rows[p][0]) >= MIN_NAMES:
                    c = _spearman(rows[p][0], rows[p][1])
                    if c is not None:
                        ic[p][h].append(c)
            for g in ("short", "long"):
                if len(g_rows[g][0]) >= MIN_NAMES:
                    c = _spearman(g_rows[g][0], g_rows[g][1])
                    if c is not None:
                        ic_gamma[g][h].append(c)

    # ---- L/S 五档扣成本回测(net_flow,H=1,日频) ----
    def ls_backtest():
        rets_gross = []
        for i, d in enumerate(dates):
            day = gd[d]
            nn_abs = [abs(r["net_nom"]) for r in day.values() if r.get("net_nom") is not None]
            floor = 0.2 * (sorted(nn_abs)[len(nn_abs) // 2] if nn_abs else 1.0) or 1.0
            cand = []
            for s, rec in day.items():
                x = netflow_norm(rec, floor); fr = fwd_ret(i, s, 1)
                if x is not None and fr is not None:
                    cand.append((x, fr))
            if len(cand) < 10:
                continue
            cand.sort(key=lambda t: t[0])
            k = max(1, len(cand) // 5)
            bot = cand[:k]; top = cand[-k:]
            long_r = sum(t[1] for t in top) / len(top)
            short_r = sum(t[1] for t in bot) / len(bot)
            rets_gross.append((d, long_r - short_r))
        if len(rets_gross) < 10:
            return {"status": "insufficient", "n": len(rets_gross)}
        # 日频全换手:每日多空各建仓 → 成本 ≈ 4 × cost_bps(两腿各进出)
        cost = 4 * COST_BPS / 1e4
        gr = [r for _, r in rets_gross]
        nr = [r - cost for r in gr]
        curve, cum = [], 1.0
        for (d, _), r in zip(rets_gross, nr):
            cum *= (1 + r); curve.append([d, round((cum - 1) * 100, 2)])

        def ann(x):
            m = sum(x) / len(x); sd = math.sqrt(sum((v - m) ** 2 for v in x) / (len(x) - 1)) if len(x) > 1 else 0
            return {"ann_pct": round(m * 252 * 100, 1), "sharpe": round(m / sd * math.sqrt(252), 2) if sd else None}

        return {"status": "ok", "n": len(gr), "cost_bps": COST_BPS, "quintile": k,
                "gross": ann(gr), "net": ann(nr), "curve_net_pct": curve}

    out = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "gex_daily.json", "n_dates": len(dates),
        "date_range": [dates[0], dates[-1]] if dates else None,
        "horizons": HORIZONS, "lag": LAG, "min_names": MIN_NAMES,
        "predictors": {}, "notes": [],
    }
    for p, meta in PREDS.items():
        out["predictors"][p] = {**meta,
                                "ic": {str(h): ic_stats(ic[p][h], h, rng) for h in HORIZONS}}
    out["predictors"]["net_flow"]["gamma_split"] = {
        g: {str(h): ic_stats(ic_gamma[g][h], h, rng) for h in HORIZONS} for g in ("short", "long")}
    out["predictors"]["net_flow"]["ls_quintile_h1"] = ls_backtest()

    if len(dates) < 40:
        out["notes"].append(f"样本极小({len(dates)} 交易日);IC 现阶段主要是噪声,标 insufficient 的先别信。")
    out["notes"].append("H>1 的每日 IC 高度重叠,CI 用 block bootstrap(非 naive);n_eff=n_days/H 是粗略有效样本。")
    out["notes"].append("entry_lag=1(信号盘后才知→次日进场),无前视;L/S 日频全换手,成本很重是诚实结果。")

    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"→ {OUT.relative_to(ROOT)}  ({len(dates)} 交易日)")
    for p in PREDS:
        row = out["predictors"][p]["ic"]
        cells = " ".join(f"{h}d:{row[h].get('mean_ic', '—')}{'*' if row[h].get('sig') else ''}" for h in map(str, HORIZONS))
        print(f"  {p:9} {cells}")
    ls = out["predictors"]["net_flow"]["ls_quintile_h1"]
    if ls.get("status") == "ok":
        print(f"  L/S net_flow H1: gross {ls['gross']['ann_pct']}% / net {ls['net']['ann_pct']}% (Sharpe net {ls['net']['sharpe']})")


if __name__ == "__main__":
    main()
