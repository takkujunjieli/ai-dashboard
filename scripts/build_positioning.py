#!/usr/bin/env python3
"""组装仓位情报 → data/positioning.json(供 research 页「仓位情报」tab)。
读 data/cot_raw.json(CFTC COT,周频)+ 指数日线(Yahoo ^GSPC/^IXIC)+ 可选 data/retailflow.json。
每 cohort 算 JPM 式 z-score + 历史分位;两种潜在买卖盘:
  ① 拥挤度 $:(当前净 − 中位净)×合约乘数×指数点位 —— 回到中位需成交的 $(签名:拥挤多→负=潜在卖)。
  ② CTA 机械触发 $:趋势模型(多均线)在各均线价位翻转 → 假设 AUM 下的 $-to-buy/sell。
纯计算 + Yahoo(免 key)。缺某源则该 cohort 优雅省略。"""
import json
import time
from pathlib import Path
from statistics import median, pstdev, mean

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "positioning.json"
CFG = json.loads((ROOT / "config" / "positioning.json").read_text())
WIN = CFG.get("pctile_window_wk", 156)
YF = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=3y&interval=1d"
IDX = {"SP500": "%5EGSPC", "NDX100": "%5EIXIC"}


def yahoo_closes(sym):
    r = requests.get(YF.format(sym=sym), headers={"User-Agent": "Mozilla/5.0"}, timeout=40)
    r.raise_for_status()
    res = r.json()["chart"]["result"][0]
    cl = res["indicators"]["quote"][0]["close"]
    return [c for c in cl if c is not None]


def pctile(hist, v):
    h = [x for x in hist if x is not None]
    return round(100 * sum(1 for x in h if x <= v) / len(h), 1) if h else None


def zscore(window, v):
    w = [x for x in window if x is not None]
    if len(w) < 8:
        return None
    sd = pstdev(w)
    return round((v - mean(w)) / sd, 2) if sd else 0.0


def cohort_from_cot(rows, cohort, mult, px):
    """cohort in {'lev','am'} → z 分数时序 + 最新 z/分位 + 拥挤$ + 周变。
    纵轴用 z(=(净−回看窗均值)/标准差,单位=σ,0=3 年均值),比原始合约数有意义且各 cohort 可比。"""
    net_key, chg_key = cohort + "_net", cohort + "_chg"
    series = [[r["date"], r[net_key]] for r in rows if r.get(net_key) is not None][-WIN:]
    nets = [v for _, v in series]
    cur = nets[-1]
    med = median(nets)
    m, sd = mean(nets), (pstdev(nets) or 1)
    series_z = [[d, round((v - m) / sd, 2)] for d, v in series]   # 仿射变换:形状不变,单位有意义
    crowd_usd = round(-(cur - med) * mult * px)    # 拥挤多(cur>med)→负=潜在卖;拥挤空→正=潜在买
    return {
        "series_z": series_z,                       # z 分数时序(画图,纵轴=σ)
        "latest": cur, "median": round(med),
        "z": round((cur - m) / sd, 2), "pctile": pctile(nets, cur),
        "weekly_chg": rows[-1].get(chg_key),
        "crowd_usd": crowd_usd,
    }


def main():
    cot = json.loads((DATA / "cot_raw.json").read_text()) if (DATA / "cot_raw.json").exists() else {"contracts": {}}
    mult = cot.get("mult", {"SP500": 50, "NDX100": 20})
    out = {"topic": "positioning", "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "window_wk": WIN, "markets": {}, "meta": {"caveats": [
               "近似 JPM Positioning Intelligence,非原品",
               "COT 滞后:周二持仓、周五发布",
               "CTA 定位读自 DBMF(复制器 ETF)每日披露持仓,代理趋势跟随者总体定位",
               "COT 为指数期货持仓,代理现货 cohort 行为",
           ]}}
    # Dealer 略去:指数期货里它主要是客户盘的对手方/对冲残差(≈ -(am+lev) 镜像),无独立方向信息。
    # 改用 real−fast 背离(资管 z − 杠杆 z)作为第三条:real money 与 fast money 的定位差,极值常见于转折前。
    COHORTS = [("lev", "杠杆基金 HF/CTA"), ("am", "资管/共同基金")]
    for key, rows in cot.get("contracts", {}).items():
        if not rows:
            continue
        try:
            px = yahoo_closes(IDX[key])[-1] if key in IDX else None
        except Exception as e:
            print(f"⚠️ {key} 指数拉取失败({e}),用 OI 占位价"); px = None
        m = mult.get(key, 50)
        idxpx = px or 1
        mkt = {"cohorts": {}}
        for ck, clabel in COHORTS:
            c = cohort_from_cot(rows, ck, m, idxpx)
            c["label"] = clabel
            mkt["cohorts"][ck] = c
        # real−fast 背离:资管 z − 杠杆 z(逐周对齐;正=real money 比 fast money 更拥挤多)
        amz = dict(mkt["cohorts"]["am"]["series_z"])
        div = [[d, round(amz[d] - z, 2)] for d, z in mkt["cohorts"]["lev"]["series_z"] if d in amz]
        mkt["divergence"] = {"series_z": div, "latest": div[-1][1] if div else None,
                             "label": "real−fast 背离(资管−杠杆)"}
        out["markets"][key] = mkt

    # 复合 TPM:各市场各 cohort 分位的均值(0-100;高=整体拥挤多)
    pcts = [c["pctile"] for mk in out["markets"].values() for c in mk["cohorts"].values() if c.get("pctile") is not None]
    out["composite_pctile"] = round(mean(pcts), 1) if pcts else None

    # 折入现有:散户(retailflow 市场级净买入均值)。13F 不用:季度数据滞后太多(45 天披露),对周频定位无意义。
    rf = DATA / "retailflow.json"
    if rf.exists():
        try:
            J = json.loads(rf.read_text())
            nbs = [d["netbuy"][-1] for d in J.get("data", {}).values() if d.get("netbuy") and d["netbuy"][-1] is not None]
            out["retail"] = {"avg_netbuy": round(mean(nbs), 4) if nbs else None, "n": len(nbs),
                             "updated": J.get("updated")}
        except Exception as e:
            print(f"⚠️ retail 折入跳过({e})")

    # CTA 定位:DBMF 复制器每日披露持仓(真实多空,非假设)。equity 历史序列供画趋势。
    dbmf = DATA / "dbmf_raw.json"
    if dbmf.exists():
        try:
            D = json.loads(dbmf.read_text())
            eq_hist = [[d, s.get("equity")] for d, s in sorted(D.get("history", {}).items()) if s.get("equity") is not None]
            out["cta"] = {"source": D.get("source"), "asof": D.get("asof"),
                          "buckets": D.get("latest", {}), "detail": D.get("detail", []),
                          "equity_series": eq_hist}
        except Exception as e:
            print(f"⚠️ DBMF CTA 折入跳过({e})")

    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    comp = out["composite_pctile"]
    print(f"→ {OUT.relative_to(ROOT)} · 市场 {list(out['markets'])} · 复合分位 {comp} "
          f"({OUT.stat().st_size/1024:.0f} KB)")
    for k, mk in out["markets"].items():
        lev = mk["cohorts"]["lev"]
        print(f"  {k}: HF/CTA net={lev['latest']:,} 分位{lev['pctile']} z{lev['z']} 拥挤${lev['crowd_usd']/1e9:.1f}B")
    if out.get("cta"):
        b = out["cta"]["buckets"]
        print(f"  CTA(DBMF {out['cta']['asof']}): 股票净 {b.get('equity'):+.1f}% (S&P {b.get('sp500'):+.1f}%) "
              f"利率 {b.get('rates'):+.1f}% 外汇 {b.get('fx'):+.1f}% 商品 {b.get('commodity'):+.1f}%")


if __name__ == "__main__":
    main()
