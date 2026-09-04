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
import urllib.request
from collections import defaultdict
from statistics import median
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UA = {"User-Agent": "Mozilla/5.0 (research-dashboard robustness)"}
BENCH = "SPY"


def yahoo_daily(sym):
    """Yahoo v8 chart(5y,1d)→ {date: adjclose}。Yahoo 代码 '.'→'-'(BRK.B→BRK-B)。"""
    ysym = sym.replace(".", "-")
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ysym}?range=5y&interval=1d"
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read())
    res = d["chart"]["result"][0]
    ts = res["timestamp"]
    ind = res["indicators"]
    adj = (ind.get("adjclose") or [{}])[0].get("adjclose")
    close = ind["quote"][0]["close"]
    vals = adj if adj else close
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
        pnl = gross = net = 0.0
        # 今日先按 trade_price 计入建/平仓的现金腿,再 mark 到 close
        day_trades = trades_on.get(d, [])
        dqmap = defaultdict(float); prmap = {}
        for sym, dq, pr in day_trades:
            dqmap[sym] += dq; prmap[sym] = pr
        touched = set(qty) | set(dqmap)
        for sym in touched:
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
        rows.append([d, pnl, gross, net])
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
all_rows_by_date = defaultdict(lambda: [0.0, 0.0, 0.0])   # date -> [pnl,gross,net] 合并
for acct, txs in tx_by_acct.items():
    rows = build_account(txs)
    for d, pnl, gross, net in rows:
        agg = all_rows_by_date[d]; agg[0] += pnl; agg[1] += gross; agg[2] += net
    accounts_out[acct] = rows

# 合并账户
all_rows = [[d, *all_rows_by_date[d]] for d in cal]


CLIP = 0.12   # 日收益 winsorize(±12%),防残余的小分母/坏价 spike

def summarize(rows, label):
    """rows: [[date,pnl,gross,net]] → {label, curve, windows}。
    日收益=pnl/前日毛敞口,但仅在毛敞口≥floor(=max($3k,0.2×中位毛敞口))时计,并 winsorize;
    剔除小账户早期天文数字。曲线含累计$P&L(始终稳健)。"""
    pos_gross = [g for _, _, g, _ in rows if g > 0]
    if not pos_gross:
        return {"label": label, "curve": [], "windows": {}, "floor_gross": 0}
    floor = max(3000.0, 0.2 * median(pos_gross))
    series = []       # (date, r_or_None, gross, net, cum_pnl)
    prev_gross = 0.0; cum = 0.0
    for d, pnl, gross, net in rows:
        cum += pnl
        r = max(-CLIP, min(CLIP, pnl / prev_gross)) if prev_gross >= floor else None
        series.append((d, r, gross, net, cum))
        prev_gross = gross
    # 曲线:净值 index(仅有效收益日复利)+ SPY 同期对照 + 累计$P&L
    curve = []
    eq = spy_eq = 100.0; spy_prev = None; started = False
    for d, r, gross, net, cum in series:
        sr, spy_prev = spy_ret(d, spy_prev)
        if r is not None:
            started = True
            eq *= (1 + r)
            if sr is not None:
                spy_eq *= (1 + sr)
        if started:
            curve.append([d, round(eq, 2), round(spy_eq, 2), round(cum)])
    # 各窗口 beta/alpha(对齐:组合有效收益日 ∩ SPY 有收益日)
    wins = {}
    for wn, start in WINDOWS.items():
        rp, rm, nets, grosses = [], [], [], []
        sp_prev = None
        for d, r, gross, net, cum in series:
            sr, sp_prev = spy_ret(d, sp_prev)
            if d >= start and r is not None and sr is not None:
                rp.append(r); rm.append(sr); nets.append(net); grosses.append(gross)
        reg = _regress(rp, rm)
        if reg:
            reg["avg_net_gross"] = round(sum(n / g for n, g in zip(nets, grosses) if g) / len(nets), 2) if nets else None
        wins[wn] = reg
    return {"label": label, "curve": curve, "windows": wins, "floor_gross": round(floor)}


out = {
    "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "benchmark": BENCH,
    "note": "M2M(含未实现),仅 equity;日收益=P&L/前日毛敞口;beta/alpha 对 SPY;alpha 年化。avg_net_gross=净/毛敞口(越低越市场中性)。",
    "window_starts": WINDOWS,
    "missing_syms": missing,
    "accounts": {acct: summarize(rows, labels.get(acct, acct)) for acct, rows in accounts_out.items()},
}
out["accounts"]["_all"] = summarize(all_rows, "全部账户")
(DATA / "robustness.json").write_text(json.dumps(out, ensure_ascii=False))

print(f"→ data/robustness.json")
for acct, o in out["accounts"].items():
    a = o["windows"].get("all") or {}
    print(f"  {o['label']:22s} all: β={a.get('beta')} α年化={a.get('alpha_annual_pct')}% "
          f"R²={a.get('r2')} Sharpe={a.get('sharpe')} 年化收益={a.get('ret_annual_pct')}% n={a.get('n')} "
          f"净/毛={a.get('avg_net_gross')}")
