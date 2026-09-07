#!/usr/bin/env python3
"""组合稳健性:从交易史重建日频 M2M 收益曲线(含未实现),对 SPY 回归出 beta/alpha。
本地分析(原料 data/_*_raw.json 私有,输出 data/robustness.json 亦私有/gitignore)。

口径:
- 只用 equity 成交(期权无日频收盘,先排除)。
- 每日 P&L(sym) = qty_end·close_d − qty_end_prev·close_prev − Δqty_today·trade_price(含未实现,做空 qty 为负,符号自洽)。
- 日收益 = 当日总 P&L / 前一日毛敞口 Σ|qty·close|(return on gross,L/S 组合标准口径)。
- beta/alpha:日收益对 SPY 日简单收益 OLS。alpha 年化 ×252,vol 年化 ×√252,Sharpe(rf=0)。
纯 stdlib。"""
import json
import glob
import math
import random
import urllib.request
from collections import defaultdict
from statistics import median
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UA = {"User-Agent": "Mozilla/5.0 (research-dashboard robustness)"}
BENCH = "SPY"
SPLIT_K = 3.0     # 单日 >3 倍价格跳变几乎必是(反)拆股口径错配,不是真实收益 → 触发保护(见 build_account)


def yahoo_daily(sym):
    """Yahoo v8 chart(5y,1d)→ {date: close}(拆股复权收盘)。Yahoo 代码 '.'→'-'(BRK.B→BRK-B)。
    quote.close 已按拆股复权(与 adjclose 差别仅在分红);成交记录则未复权,故 1b 把成交按比例
    归一到此复权基准,避免 UVIX/SOXS 等反拆股 ETF 的巨额虚假 M2M(6 月假暴涨即此)。"""
    ysym = sym.replace(".", "-")
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ysym}?range=5y&interval=1d"
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read())
    res = d["chart"]["result"][0]
    ts = res["timestamp"]
    vals = res["indicators"]["quote"][0]["close"]   # 原始未复权收盘(不用 adjclose)
    out = {}
    for t, v in zip(ts, vals):
        if v is not None:
            out[datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d")] = float(v)
    return out


# ---------- 1) 读交易(equity)----------
tx_by_acct = defaultdict(list)   # acct -> [(date, sym, dqty, price)]
labels = {}
syms = set()
for f in sorted(glob.glob(str(DATA / "_*_raw.json"))):
    d = json.loads(Path(f).read_text())
    for a in d.get("accounts", []):
        labels[a["id"]] = a.get("label", a["id"])
    for t in d.get("transactions", []):
        if t.get("kind") != "equity":
            continue
        sym, side = t.get("sym"), (t.get("side") or "").lower()
        q, pr = t.get("qty"), t.get("price")
        if not sym or q is None or pr is None:
            continue
        dq = float(q) if "buy" in side else -float(q)   # buy/cover=+,sell/sell_short=-
        tx_by_acct[t["account"]].append((t["ts"][:10], sym, dq, float(pr)))
        syms.add(sym)

# ---------- 2) 拉日收盘(含 SPY)----------
prices, missing = {}, []
CACHE = DATA / ".px_cache.json"          # 当日价格缓存(gitignore),避免重跑重复拉
_today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
_cache = {}
if CACHE.exists():
    try:
        cj = json.loads(CACHE.read_text())
        if cj.get("date") == _today:
            _cache = cj.get("prices", {})
    except (json.JSONDecodeError, OSError):
        pass
for s in sorted(syms | {BENCH}):
    if s in _cache:
        prices[s] = _cache[s]
        continue
    try:
        px = yahoo_daily(s)
        if px:
            prices[s] = px
        else:
            missing.append(s)
    except Exception:
        missing.append(s)
try:
    CACHE.write_text(json.dumps({"date": _today, "prices": prices}))
except OSError:
    pass
print(f"价格:{len(prices)}/{len(syms) + 1} 成功(缓存 {len(_cache)});缺失 {len(missing)}: {missing}")

cal = sorted(prices.get(BENCH, {}).keys())     # 用 SPY 交易日历
cal_set = set(cal)

# ---------- 1b) 拆股口径归一(把成交记录换算到 Yahoo 复权价基准) ----------
# Yahoo 历史价按累计(反)拆股复权,而成交记录是「未复权 qty/成交价」。二者相乘会产生巨额虚假 M2M
# —— 如 SOXS 频繁反拆股使 2023 复权价达 $58 万(成交 $20)、UVIX $80(成交 $4),乘未复权 qty → 假暴涨。
# 修正(对全部标的通用,保留真实盈亏,含 NVDA 等正常拆股):任一笔成交价与其当日(或最近已知)
# 复权收盘背离 >SPLIT_K 倍 → 视为拆股口径差,按比例把该笔换算到复权基准(现金 qty×price 不变)。
def _nearest_close(sym, d):
    px = prices.get(sym)
    if not px:
        return None
    if d in px:
        return px[d]
    ks = [k for k in px if k <= d]
    return px[max(ks)] if ks else None

_adj_syms = set()
for acct, _txs in tx_by_acct.items():
    fixed = []
    for dt, sym, dq, pr in _txs:
        c = _nearest_close(sym, dt)
        if c and c > 0 and pr > 0 and (c / pr > SPLIT_K or pr / c > SPLIT_K):
            f = pr / c              # 成交价/复权收盘 ≈ 该笔的累计拆股因子
            dq = dq * f             # qty 换算到复权基准(现金 dq*pr 保持不变)
            pr = c
            _adj_syms.add(sym)
        fixed.append((dt, sym, dq, pr))
    tx_by_acct[acct] = fixed
if _adj_syms:
    print(f"拆股口径归一(成交价与复权收盘背离 >{SPLIT_K}x → 按比例把该笔换算到复权基准,现金不变):{sorted(_adj_syms)}")


def fwd_close(sym, d, last):
    """取 sym 在 d 的收盘;缺则沿用上一个已知(forward-fill)。返回 (close_or_None, new_last)。"""
    px = prices.get(sym)
    if px is None:
        return None, last
    if d in px:
        return px[d], px[d]
    return last, last   # 用上次已知(可能 None)


# ---------- 3) 每账户重建日频 P&L / 毛敞口 / 收益 ----------
def build_account(txs):
    """txs: [(date,sym,dqty,price)] → {dates, ret[], pnl[], gross[], net[], long_pnl[], short_pnl[]}"""
    trades_on = defaultdict(list)      # date -> [(sym,dqty,price)]
    for dt, sym, dq, pr in txs:
        if dt in cal_set or dt <= cal[-1]:
            trades_on[dt].append((sym, dq, pr))
    qty = defaultdict(float)           # sym -> 当前持仓
    prev_close = {}                    # sym -> 上一已知收盘
    prev_mv = defaultdict(float)       # sym -> 上一日 qty·close
    rows = []
    for d in cal:
        pnl = gross = net = lpnl = spnl = lgross = sgross = 0.0
        # 今日先按 trade_price 计入建/平仓的现金腿,再 mark 到 close
        day_trades = trades_on.get(d, [])
        dqmap = defaultdict(float); prmap = {}
        for sym, dq, pr in day_trades:
            dqmap[sym] += dq; prmap[sym] = pr
        touched = set(qty) | set(dqmap)
        for sym in touched:                          # 成交已在 1b 归一到复权价基准,故此处直接用复权收盘 mark
            c, prev_close[sym] = fwd_close(sym, d, prev_close.get(sym))
            q0 = qty[sym]
            dq = dqmap.get(sym, 0.0)
            q1 = q0 + dq
            qty[sym] = q1
            if c is None:              # 无价:无法 mark,跳过其 P&L(记 missing 已提示)
                prev_mv[sym] = prev_mv.get(sym, 0.0)
                continue
            mv1 = q1 * c
            cash = dq * prmap.get(sym, c)             # 今日投入现金腿(买入为正)
            p = mv1 - prev_mv.get(sym, 0.0) - cash    # 该 sym 当日 M2M P&L
            pnl += p
            prev_mv[sym] = mv1
            gross += abs(mv1); net += mv1
            if q1 >= 0:                # 按当日末持仓方向归多/空腿
                lpnl += p; lgross += abs(mv1)
            else:
                spnl += p; sgross += abs(mv1)
        rows.append([d, pnl, gross, net, lpnl, spnl, lgross, sgross])
    return rows


def _regress(rp, rm):
    n = len(rp)
    if n < 20:
        return None
    mp = sum(rp) / n; mm = sum(rm) / n
    var_m = sum((x - mm) ** 2 for x in rm) / n
    cov = sum((rp[i] - mp) * (rm[i] - mm) for i in range(n)) / n
    if var_m == 0:
        return None
    beta = cov / var_m
    alpha_d = mp - beta * mm
    var_p = sum((x - mp) ** 2 for x in rp) / n
    r2 = (cov ** 2) / (var_m * var_p) if var_p else 0.0
    sd = math.sqrt(var_p * n / (n - 1))
    return {
        "n": n, "beta": round(beta, 3), "alpha_annual_pct": round(alpha_d * 252 * 100, 2),
        "r2": round(r2, 3), "corr": round(math.copysign(math.sqrt(r2), beta), 3),
        "ret_annual_pct": round(mp * 252 * 100, 2),
        "vol_annual_pct": round(sd * math.sqrt(252) * 100, 2),
        "sharpe": round(mp / sd * math.sqrt(252), 2) if sd else None,
        "avg_net_gross": None,   # 填在外面
    }


def spy_ret(d, prev):
    c = prices[BENCH].get(d)
    return (c / prev - 1.0, c) if (c and prev) else (None, c or prev)


ad = datetime.now(timezone.utc).date()
WINDOWS = {"all": "1900-01-01",
           "ytd": f"{ad.year}-01-01",
           "1y": (ad - timedelta(days=365)).isoformat(),
           "3m": (ad - timedelta(days=92)).isoformat()}

accounts_out = {}
all_rows_by_date = defaultdict(lambda: [0.0] * 7)   # date -> [pnl,gross,net,lpnl,spnl,lgross,sgross] 合并
for acct, txs in tx_by_acct.items():
    rows = build_account(txs)
    for r in rows:
        agg = all_rows_by_date[r[0]]
        for i in range(7):
            agg[i] += r[i + 1]
    accounts_out[acct] = rows

# 合并账户
all_rows = [[d, *all_rows_by_date[d]] for d in cal]


CLIP = 0.12   # 日收益 winsorize(±12%),防残余的小分母/坏价 spike


def _floor(vals):
    v = [x for x in vals if x > 0]
    return max(3000.0, 0.2 * median(v)) if v else 1e18   # 无仓 → floor 极大 → 该腿 r 恒 None


def _clip(x):
    return max(-CLIP, min(CLIP, x))


# ---------- ② 分块 bootstrap 置信区间(moving-block,保留自相关;非参,肥尾友好)----------
def _mbb(n, rng, block=5):
    idx = []
    while len(idx) < n:
        s = rng.randrange(max(1, n - block + 1))
        idx.extend(range(s, min(s + block, n)))
    return idx[:n]


def _ci(vals):
    if not vals:
        return None
    v = sorted(vals)
    lo = v[max(0, int(0.025 * len(v)))]
    hi = v[min(len(v) - 1, int(0.975 * len(v)))]
    return [round(lo, 2), round(hi, 2)]


def bootstrap_reg(rp, rm, B=800, block=5):
    """总收益序列对 SPY 回归的 β/α年化/Sharpe/年化收益 95% CI + α 是否显著(CI 不跨 0)。"""
    n = len(rp)
    if n < 25:
        return None
    rng = random.Random(42)
    bs, als, shs, rts = [], [], [], []
    for _ in range(B):
        idx = _mbb(n, rng, block)
        g = _regress([rp[i] for i in idx], [rm[i] for i in idx])
        if not g:
            continue
        bs.append(g["beta"]); als.append(g["alpha_annual_pct"]); rts.append(g["ret_annual_pct"])
        if g["sharpe"] is not None:
            shs.append(g["sharpe"])
    ac = _ci(als)
    return {"beta": _ci(bs), "alpha": ac, "sharpe": _ci(shs), "ret": _ci(rts),
            "alpha_sig": bool(ac and (ac[0] > 0 or ac[1] < 0))}


def bootstrap_mean_annual(series, B=800, block=5):
    """一条日收益序列的 年化收益(mean×252)95% CI。"""
    n = len(series)
    if n < 20:
        return None
    rng = random.Random(7)
    out = [sum(series[i] for i in _mbb(n, rng, block)) / n * 252 * 100 for _ in range(B)]
    return _ci(out)


def summarize(rows, label):
    """rows: [date,pnl,gross,net,lpnl,spnl,lgross,sgross] → {label,curve,windows}。
    ① 总/多头/空头 三条日收益(各 =腿P&L/前日腿毛敞口,腿毛敞口≥floor 才计,winsorize)。
    ② 每窗口 总收益 β/α/Sharpe 带 bootstrap CI;多/空腿 年化收益带 CI + β。曲线含累计$(总/多/空)。"""
    if not any(r[2] > 0 for r in rows):
        return {"label": label, "curve": [], "windows": {}}
    gf, lf, sf = _floor([r[2] for r in rows]), _floor([r[6] for r in rows]), _floor([r[7] for r in rows])
    series = []       # (date, rt, rl, rs, gross, net, cum, cum_l, cum_s)
    pg = lg = sg = 0.0; cum = cl = cs = 0.0
    for d, pnl, gross, net, lpnl, spnl, lgross, sgross in rows:
        cum += pnl; cl += lpnl; cs += spnl
        rt = _clip(pnl / pg) if pg >= gf else None
        rl = _clip(lpnl / lg) if lg >= lf else None
        rs = _clip(spnl / sg) if sg >= sf else None
        series.append((d, rt, rl, rs, gross, net, cum, cl, cs))
        pg, lg, sg = gross, lgross, sgross
    # 曲线:累计 $P&L(总/多/空);仅从有有效总收益日起画
    curve = []; started = False
    for d, rt, rl, rs, gross, net, cum, cl, cs in series:
        if rt is not None:
            started = True
        if started:
            curve.append([d, round(cum), round(cl), round(cs)])
    # 月历:每月 净收益$(累计差)+ 收益率%(日收益复利)+ log 收益(Σ ln(1+r),可加、便于可视化)
    monthly, mmap = [], {}
    started = False; prev_cum = 0.0
    for d, rt, rl, rs, gross, net, cum, cl, cs in series:
        if rt is not None:
            started = True
        if not started:
            prev_cum = cum; continue
        m = mmap.get(d[:7])
        if m is None:
            m = mmap[d[:7]] = {"ym": d[:7], "pnl": 0.0, "logret": 0.0}; monthly.append(m)
        m["pnl"] += cum - prev_cum; prev_cum = cum
        if rt is not None:
            m["logret"] += math.log(1.0 + rt)
    for m in monthly:
        m["pnl"] = round(m["pnl"])
        m["ret_pct"] = round((math.exp(m["logret"]) - 1) * 100, 2)   # 复利月收益
        m["logret"] = round(m["logret"], 4)
    # 各窗口
    wins = {}
    for wn, start in WINDOWS.items():
        rp, rm, nets, grosses, rl_, rml, rs_, rms = [], [], [], [], [], [], [], []
        sp = None
        for d, rt, rl, rs, gross, net, cum, cl, cs in series:
            srr, sp = spy_ret(d, sp)   # sp 逐日推进(即使窗口外),保证相邻日 SPY 收益正确
            if d < start or srr is None:
                continue
            if rt is not None: rp.append(rt); rm.append(srr); nets.append(net); grosses.append(gross)
            if rl is not None: rl_.append(rl); rml.append(srr)
            if rs is not None: rs_.append(rs); rms.append(srr)
        reg = _regress(rp, rm)
        if reg:
            reg["avg_net_gross"] = round(sum(n / g for n, g in zip(nets, grosses) if g) / len(nets), 2) if nets else None
            reg["ci"] = bootstrap_reg(rp, rm)
            lreg, sreg = _regress(rl_, rml), _regress(rs_, rms)
            reg["long"] = {"n": len(rl_), "ret_annual_pct": lreg["ret_annual_pct"] if lreg else None,
                           "beta": lreg["beta"] if lreg else None, "ret_ci": bootstrap_mean_annual(rl_)}
            reg["short"] = {"n": len(rs_), "ret_annual_pct": sreg["ret_annual_pct"] if sreg else None,
                            "beta": sreg["beta"] if sreg else None, "ret_ci": bootstrap_mean_annual(rs_)}
        wins[wn] = reg
    return {"label": label, "curve": curve, "monthly": monthly, "windows": wins, "floor_gross": round(gf)}


out = {
    "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "benchmark": BENCH,
    "note": "M2M(含未实现),仅 equity;日收益=腿P&L/前日腿毛敞口;β/α 对 SPY,α 年化。"
            "曲线=累计$P&L[总,多头,空头]。ci=bootstrap 95%(α_sig=CI不跨0=显著)。long/short=多空腿归因。",
    "window_starts": WINDOWS,
    "missing_syms": missing,
    "accounts": {acct: summarize(rows, labels.get(acct, acct)) for acct, rows in accounts_out.items()},
}
out["accounts"]["_all"] = summarize(all_rows, "全部账户")
(DATA / "robustness.json").write_text(json.dumps(out, ensure_ascii=False))

print("→ data/robustness.json")
for acct, o in out["accounts"].items():
    for wn in ("ytd", "all"):
        a = o["windows"].get(wn) or {}
        if not a:
            continue
        ci = a.get("ci") or {}
        lg, st = a.get("long") or {}, a.get("short") or {}
        print(f"  {o['label']:16s} {wn:3s}: β={a.get('beta')} α={a.get('alpha_annual_pct')}%"
              f" CI{ci.get('alpha')} sig={ci.get('alpha_sig')} Sharpe={a.get('sharpe')} n={a.get('n')}"
              f" | 多头 {lg.get('ret_annual_pct')}%{lg.get('ret_ci')} β{lg.get('beta')}"
              f" | 空头 {st.get('ret_annual_pct')}%{st.get('ret_ci')} β{st.get('beta')}")
