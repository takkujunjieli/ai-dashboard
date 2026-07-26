#!/usr/bin/env python3
"""生成短线分析报告 (analysis_report_<date>.md)。

固化 docs/analysis_report_playbook.md 的逻辑：读取 data/research.json + data/gex.json
两个快照，逐票拼装五段结构的 Markdown 报告。指标解读，非投资建议。

用法:
    python scripts/gen_report.py                    # 写到 analysis_report_<快照日期>.md
    python scripts/gen_report.py --stdout           # 打印到标准输出
    python scripts/gen_report.py --bucket week      # 选 GEX 到期桶 (默认 0dte)
    python scripts/gen_report.py --afterhours       # 头部标注盘后采集
    python scripts/gen_report.py -o /path/report.md
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUCKETS = ["0dte", "week", "2wk", "all"]  # 累计口径，前端默认 0DTE
ETF_HINT = {"SPY", "QQQ", "SOXX", "IWM", "DIA"}  # 无 flow-GEX 的兜底判断

# ---- 门槛 (见 playbook §2；经验值，待回测校准) --------------------------------
IV_DISTORT = 1.00       # atm_iv >= 100% 视为偏高
EARN_WEEK_DAYS = 7      # 财报在 7 天内则不判失真
FLOW_WEAK_COV = 0.40    # flow 覆盖 < 40% → 方向读数偏弱
PCR_CALL = 0.70         # < 0.7 call 偏重
PCR_PUT = 1.30          # > 1.3 put 偏重
ATM_BAND = 0.03         # ATM 分歧扫描带 ±3%
TRADING_YEAR = 365.0    # 预期波动用日历日年化 (已用 SPY/QQQ/TSLA/SNDK 校验)


# ---- 数值格式 -----------------------------------------------------------------
def f2(x) -> str:
    return "—" if x is None else f"{x:,.2f}"


def f0(x) -> str:
    return "—" if x is None else f"{x:,.0f}"


def m(x) -> str:
    """金额 → 百万 (M)。"""
    return "—" if x is None else f"{x / 1e6:.0f}M"


def pct1(x) -> str:
    return "—" if x is None else f"{x * 100:.1f}%"


def sign_pct1(x) -> str:
    return "—" if x is None else f"{x * 100:+.1f}%"


# ---- 桶取值 (缺失则向后回退到非空桶) -----------------------------------------
def bucket_val(node: dict, chosen: str, key: str):
    """从 node.buckets[chosen][key] 取值；flip/by_strike 为空时按 BUCKETS 顺序回退。"""
    bk = node.get("buckets", {})
    order = BUCKETS[BUCKETS.index(chosen):] + BUCKETS[: BUCKETS.index(chosen)]
    for b in order:
        v = bk.get(b, {}).get(key)
        if v not in (None, [], {}):
            return v
    return bk.get(chosen, {}).get(key)


# ---- 结构判断 -----------------------------------------------------------------
def close_position(o, h, l, c):
    if h is None or l is None or c is None or h == l:
        return "收于日内中部(震荡)"
    pos = (c - l) / (h - l)
    if pos >= 0.66:
        return "收于日内上部(收高/偏强)"
    if pos <= 0.33:
        return "收于日内下部(冲高回落/偏弱)"
    return "收于日内中部(震荡)"


def rsi_tag(v):
    if v is None:
        return "—"
    if v >= 70:
        return f"{v:.2f}(超买)"
    if v <= 30:
        return f"{v:.2f}(超卖)"
    return f"{v:.2f}(中性)"


def pcr_tag(v):
    if v is None:
        return "—"
    if v < PCR_CALL:
        return "call 偏重(活跃度偏多)"
    if v > PCR_PUT:
        return "put 偏重(活跃度偏空)"
    return "均衡"


def skew_tag(rr):
    if rr is None:
        return "—"
    if rr > 0.005:
        return "put skew·左尾偏肥"
    if rr < -0.005:
        return "call skew·右尾偏肥"
    return "flat"


def next_friday(d: dt.date) -> dt.date:
    """快照日之后最近的周五 (标准周度到期)。"""
    ahead = (4 - d.weekday()) % 7  # 周五=4
    ahead = ahead if ahead >= 1 else 7
    return d + dt.timedelta(days=ahead)


def walls(by_strike, spot):
    """上方正墙 top3、下方负墙 top2。"""
    ups = sorted((s for s in by_strike if s["strike"] > spot and s["net"] > 0),
                 key=lambda s: -s["net"])[:3]
    downs = sorted((s for s in by_strike if s["strike"] < spot and s["net"] < 0),
                   key=lambda s: s["net"])[:2]
    return ups, downs


def atm_divergence(nom_bs, flow_bs, spot):
    """现价 ±ATM_BAND 内、名义与 flow 符号相反的行权价。"""
    if not flow_bs:
        return []
    flow = {s["strike"]: s["net"] for s in flow_bs}
    lo, hi = spot * (1 - ATM_BAND), spot * (1 + ATM_BAND)
    out = []
    for s in nom_bs:
        k = s["strike"]
        if not (lo <= k <= hi):
            continue
        fn = flow.get(k)
        if fn is None:
            continue
        if s["net"] * fn < 0 and abs(s["net"]) > 1 and abs(fn) > 1:
            out.append(k)
    return sorted(out)


# ---- 单票分析块 ---------------------------------------------------------------
def analyze(sym, R, G, chosen, ref_exp, ref_days):
    O = R.get("options", {})
    flow = G.get("flow")
    is_etf = flow is None or sym in ETF_HINT

    spot = G.get("spot") or R.get("spot")
    bars = R.get("bars_d") or []
    last = bars[-1] if bars else None
    prev = bars[-2] if len(bars) >= 2 else None
    o = last[1] if last else None
    h = last[2] if last else None
    lo = last[3] if last else None
    c = last[4] if last else None
    chg = (c - prev[4]) / prev[4] if (c is not None and prev) else None
    vwap = R.get("vwap")
    ind = R.get("ind", {})
    sv = (R.get("short_vol") or [{}])[-1]
    short = R.get("short", {})

    # GEX
    net_nom = bucket_val(G, chosen, "net_gex")
    flip_nom = bucket_val(G, chosen, "flip")
    bs_nom = bucket_val(G, chosen, "by_strike") or []
    if flow:
        net_flow = bucket_val(flow, chosen, "net_gex")
        flip_flow = bucket_val(flow, chosen, "flip")
        bs_flow = bucket_val(flow, chosen, "by_strike") or []
        cov = flow.get("coverage")
    else:
        net_flow = flip_flow = cov = None
        bs_flow = []
    ups, downs = walls(bs_nom, spot)
    div = atm_divergence(bs_nom, bs_flow, spot)

    # 区制
    if flip_nom is None:
        region = "—"
        region_word = "整理"
    elif spot > flip_nom:
        region = "正gamma(稳)"
        region_word = "整理"
    else:
        region = "负gamma(放大)"
        region_word = "震荡"

    # 期权指标
    iv = O.get("atm_iv")
    iv_far = O.get("iv_term")
    skew_rr = O.get("skew_rr")
    maxpain = O.get("max_pain")
    maxpain_exp = O.get("max_pain_exp")
    pcr_v = O.get("pcr_vol")
    pcr_oi = O.get("pcr_oi")
    pcr_p = O.get("pcr_prem")

    sig1 = iv / math.sqrt(TRADING_YEAR) if iv else None       # 次日 1σ
    sigN = iv * math.sqrt(ref_days / TRADING_YEAR) if iv else None
    rng1 = (spot * (1 - sig1), spot * (1 + sig1)) if sig1 else None
    rngN = (spot * (1 - sigN), spot * (1 + sigN)) if sigN else None
    mp_gap = (spot - maxpain) / maxpain if (maxpain and spot) else None

    term_word = ""
    if iv is not None and iv_far is not None:
        term_word = "backwardation·近端紧张" if iv > iv_far else "contango·正常"

    # 资金
    call_p = O.get("call_premium")
    put_p = O.get("put_premium")
    net_p = (call_p - put_p) if (call_p is not None and put_p is not None) else None
    tops = O.get("top_strikes", [])[:5]

    def top_fmt(t):
        side = "C" if t.get("side") == "call" else "P"
        exp = (t.get("exp") or "")[5:]
        return f"{f2(t['strike'])}{side}({exp})"

    # 情景关键位
    resist = ups[0]["strike"] if ups else None
    accel = downs[0]["strike"] if downs else None
    support = maxpain if maxpain is not None else accel
    long_trig = flip_flow if flip_flow is not None else flip_nom

    # ---- 标注 (顺序见 playbook) ----
    earn_days = R.get("earnings_days")
    notes = ["无 IV 历史分位"]
    tags = []  # 汇总表关键提示
    iv_distort = (iv is not None and iv >= IV_DISTORT
                  and (earn_days is None or earn_days > EARN_WEEK_DAYS))
    if iv_distort:
        ed = "N/A" if earn_days is None else f"{earn_days}d"
        notes.append(f"ATM IV {pct1(iv)} 偏高但本周无财报(earn {ed})"
                     f"→ 疑近月失真,预期振幅需核对原始 IV")
        tags.append("IV疑失真")
    if is_etf:
        notes.append("ETF 无 flow-GEX")
        tags.append("ETF")
    elif cov is not None and cov < FLOW_WEAK_COV:
        notes.append(f"flow 覆盖仅 {cov * 100:.0f}% → 方向读数偏弱")
        tags.append("flow弱")
    if flip_nom is None:
        notes.append("raw flip 越界(现价远离 gamma 密集区)")

    return {
        "sym": sym, "spot": spot, "region": region, "region_word": region_word,
        "flip_nom": flip_nom, "flip_flow": flip_flow, "is_etf": is_etf,
        "o": o, "h": h, "l": lo, "c": c, "chg": chg, "vwap": vwap,
        "rsi_d": ind.get("rsi_d"), "rsi_m": ind.get("rsi_m"),
        "short_vol": sv.get("ratio"), "dtc": short.get("days_to_cover"),
        "net_nom": net_nom, "net_flow": net_flow, "cov": cov,
        "ups": ups, "downs": downs, "div": div,
        "iv": iv, "iv_far": iv_far, "sig1": sig1, "sigN": sigN,
        "rng1": rng1, "rngN": rngN, "term_word": term_word,
        "skew_rr": skew_rr, "maxpain": maxpain, "maxpain_exp": maxpain_exp,
        "mp_gap": mp_gap, "pcr_v": pcr_v, "pcr_oi": pcr_oi, "pcr_p": pcr_p,
        "call_p": call_p, "put_p": put_p, "net_p": net_p,
        "tops": [top_fmt(t) for t in tops],
        "resist": resist, "accel": accel, "support": support,
        "long_trig": long_trig, "notes": notes, "tags": tags,
        "ref_exp": ref_exp, "ref_days": ref_days,
    }


# ---- 渲染 ---------------------------------------------------------------------
def render_summary_row(a):
    flip = f"{f2(a['flip_nom'])}/{f2(a['flip_flow'])}"
    reg = {"正gamma(稳)": "正γ", "负gamma(放大)": "负γ"}.get(a["region"], "—")
    nd = pct1(a["sig1"]).rstrip("%")
    nd = f"±{nd}" if a["sig1"] else "—"
    skew = f"{a['skew_rr'] * 100:+.0f}%" if a["skew_rr"] is not None else "—"
    tags = ", ".join(a["tags"]) if a["tags"] else "—"
    return (f"| {a['sym']} | {f2(a['spot'])} | {flip} | {reg} | {nd} | "
            f"{f2(a['maxpain'])} | {skew} | {f2(a['pcr_v'])} | {tags} |")


def render_ticker(a):
    L = []
    L.append(f"## {a['sym']}\n")
    flip_desc = "flip 越界" if a["flip_nom"] is None else \
        ("现价 > flip · 正gamma(稳)" if a["region"] == "正gamma(稳)" else "现价 < flip · 负gamma(放大)")
    L.append(f"> spot **{f2(a['spot'])}** · flip(nom) {f2(a['flip_nom'])} / "
             f"flow {f2(a['flip_flow'])} · {flip_desc} · maxpain {f2(a['maxpain'])} · "
             f"ATM IV {pct1(a['iv'])} · PCR vol/OI/prem "
             f"{f2(a['pcr_v'])}/{f2(a['pcr_oi'])}/{f2(a['pcr_p'])}\n")

    # 1
    L.append("**1. 现价与近端结构**")
    vwap_rel = "—"
    if a["vwap"] is not None and a["c"] is not None:
        vwap_rel = "高于" if a["c"] >= a["vwap"] else "低于"
    L.append(f"- 日线 O{f2(a['o'])} H{f2(a['h'])} L{f2(a['l'])} C{f2(a['c'])},"
             f"{close_position(a['o'], a['h'], a['l'], a['c'])};较前收 {sign_pct1(a['chg'])};"
             f"{vwap_rel} VWAP {f2(a['vwap'])};RSI(D) {rsi_tag(a['rsi_d'])};"
             f"RSI(1m) {f2(a['rsi_m'])};"
             f"short vol {f'{a['short_vol'] * 100:.0f}%' if a['short_vol'] is not None else '—'};"
             f"days-to-cover {f2(a['dtc'])}\n")

    # 2
    L.append("**2. Gamma 结构**")
    if a["is_etf"]:
        L.append(f"- net GEX nom {m(a['net_nom'])} / flow 0M(flow N/A)")
    else:
        L.append(f"- net GEX nom {m(a['net_nom'])} / flow {m(a['net_flow'])}"
                 f"(覆盖 {f'{a['cov'] * 100:.0f}%' if a['cov'] is not None else 'N/A'})")
    if a["ups"]:
        up = ", ".join(f"{f2(s['strike'])}(+{s['net'] / 1e6:.0f}M)" for s in a["ups"])
        L.append(f"- 上方正墙(阻力/磁吸): {up}")
    if a["downs"]:
        dn = ", ".join(f"{f2(s['strike'])}({s['net'] / 1e6:.0f}M)" for s in a["downs"])
        L.append(f"- 下方负墙(加速): {dn}")
    if a["div"]:
        ds = ", ".join(f2(k) for k in a["div"])
        L.append(f"- ⚠️ ATM 分歧: {ds} 处 raw 与 real 符号相反(该带信 real)")
    L.append("")

    # 3
    L.append("**3. 预期波动 / 价格分布**")
    parts = []
    if a["sig1"]:
        parts.append(f"ATM IV {pct1(a['iv'])} → 次日 ±{a['sig1'] * 100:.1f}% "
                     f"(≈{f0(a['rng1'][0])}–{f0(a['rng1'][1])})")
        parts.append(f"到 {a['ref_exp']}(~{a['ref_days']}d) ±{a['sigN'] * 100:.1f}% "
                     f"(≈{f0(a['rngN'][0])}–{f0(a['rngN'][1])})")
    parts.append(f"IV skew RR {sign_pct1(a['skew_rr'])} ({skew_tag(a['skew_rr'])})")
    if a["maxpain"] is not None:
        parts.append(f"max pain {f2(a['maxpain'])}({a['maxpain_exp']}),"
                     f"现价{sign_pct1(a['mp_gap'])}")
    if a["term_word"]:
        parts.append(f"IV 期限 {pct1(a['iv'])}→{pct1(a['iv_far'])} ({a['term_word']})")
    L.append("- " + ";".join(parts) + "\n")

    # 4
    L.append("**4. 期权持仓 / 资金**")
    tops = ", ".join(a["tops"]) if a["tops"] else "—"
    L.append(f"- 权利金 C {m(a['call_p'])} / P {m(a['put_p'])}(net {m(a['net_p'])});"
             f"PCR vol {f2(a['pcr_v'])} → {pcr_tag(a['pcr_v'])};最活跃: {tops};"
             f"注:权利金=活跃度非买卖方向,与 skew 合看\n")

    # 5
    L.append("**5. 本周情景 + 数据质量**")
    L.append(f"- 关键位: 上方阻力/门槛 ~**{f2(a['resist'])}**;"
             f"下方支撑 ~**{f2(a['support'])}**,跌破加速带 {f2(a['accel'])}")
    L.append(f"- 基准: 在 {f2(a['support'])}–{f2(a['resist'])} 间{a['region_word']};"
             f"偏多需站上 {f2(a['long_trig'])};偏空看丢 {f2(a['support'])}")
    L.append(f"- 标注: {'; '.join(a['notes'])}\n")
    return "\n".join(L)


def build_report(research, gex, chosen, afterhours):
    asof = research.get("updated_at", "")
    try:
        snap_date = dt.datetime.fromisoformat(asof.replace("Z", "+00:00")).date()
    except ValueError:
        snap_date = dt.date.today()
    ref = next_friday(snap_date)
    ref_exp = ref.isoformat()
    ref_days = (ref - snap_date).days

    syms = list(research.get("tickers", {}).keys())
    rows = []
    for s in syms:
        R = research["tickers"][s]
        G = gex.get("tickers", {}).get(s, {})
        if not G.get("spot") and not R.get("spot"):
            continue
        rows.append(analyze(s, R, G, chosen, ref_exp, ref_days))

    src = "盘后手动采集" if afterhours else "盘中滚动采集"
    out = []
    out.append(f"# 短线分析报告 · 全 watchlist（{len(rows)} 支）\n")
    out.append(f"数据快照: `{asof}`（{src}）· 生成: 基于交易台 research.json + "
               f"gex.json 指标 · GEX 桶: {chosen}\n")
    out.append("> **全局数据质量前提**：(1) 本快照若为**盘后**采集，现价/日内量为盘后读数，"
               "RTH 真值以当日日线为准；(2) `gex_daily` 历史不足 → 所有 IV/PCR **自身分位缺失**，"
               "无法判断相对高低；(3) flow-GEX 仅对**单名股**、且仅覆盖最活跃合约(见各票覆盖率)；"
               "ETF(SPY/QQQ/SOXX)无 flow。(4) 权利金/PCR 为**活跃度非方向**。"
               "以下为指标解读，非投资建议。\n")

    # 汇总表
    out.append("## 汇总速览\n")
    out.append("| 票 | spot | flip(nom/flow) | 区制 | 次日±% | maxpain | skew | PCRv | 关键提示 |")
    out.append("|---|---|---|---|---|---|---|---|---|")
    out.extend(render_summary_row(a) for a in rows)
    out.append("")

    for a in rows:
        out.append(render_ticker(a))
        out.append("---\n")

    return "\n".join(out), snap_date


def main():
    ap = argparse.ArgumentParser(description="生成短线分析报告")
    ap.add_argument("--research", default=os.path.join(REPO, "data", "research.json"))
    ap.add_argument("--gex", default=os.path.join(REPO, "data", "gex.json"))
    ap.add_argument("--bucket", default="0dte", choices=BUCKETS,
                    help="GEX 到期桶 (默认 0dte，近月 gamma 主导当日钉价)")
    ap.add_argument("--afterhours", action="store_true", help="头部标注盘后采集")
    ap.add_argument("--stdout", action="store_true", help="打印到标准输出而非写文件")
    ap.add_argument("-o", "--out", help="输出路径 (默认 analysis_report_<快照日期>.md)")
    args = ap.parse_args()

    with open(args.research) as f:
        research = json.load(f)
    with open(args.gex) as f:
        gex = json.load(f)

    report, snap_date = build_report(research, gex, args.bucket, args.afterhours)

    if args.stdout:
        print(report)
        return
    out = args.out or os.path.join(REPO, f"analysis_report_{snap_date.isoformat()}.md")
    with open(out, "w") as f:
        f.write(report)
    print(f"已生成 {out} ({report.count(chr(10))} 行)")


if __name__ == "__main__":
    main()
