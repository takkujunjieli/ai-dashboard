#!/usr/bin/env python3
"""已实现盈亏分析引擎。

读 data/_<account>_raw.json 的交易明细,用【带符号加权平均成本法】按整段历史滚动,
产出各年/指定年已实现盈亏(markdown,本地报告用),并可 --emit 出 data/pnl.json
(供公开面板画指标 + 每笔盈亏分布,按账户 × YTD/3M/1M 窗口)。

口径:buy=+qty, sell/sell_short=-qty(cover 记 buy);平仓 realized = 平掉量 ×
(价 - 均价) × (+1多/-1空),翻仓则剩余按本次价开仓。期权 price 为"每张美元"(qty×price,
无 ×100);正股为每股。只算已实现。未含分红/利息/手续费/wash-sale/拆股校正。

用法:
  python3 analysis/analyze_pnl.py --year 2026        # 本地 markdown 报告
  python3 analysis/analyze_pnl.py --emit             # 生成 data/pnl.json(公开面板用)
"""
import argparse
import json
import math
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_FILES = ["data/_takku_raw.json", "data/_rh_raw.json"]   # 有完整历史、可算 P&L 的账户原料

# rf 与 MAR(最低可接受收益)统一取此年化值(全局)。因指标基于每日美元 P&L,需账户资本
# 把年化% 折成每日美元门槛:日门槛$ = 资本 × RISK_FREE_ANNUAL / 252。
RISK_FREE_ANNUAL = 0.15
TRADING_DAYS = 252
ACCOUNT_CAPITAL = {          # 账户资本基数≈当前市值(equity_value),随市值变动手改
    "rh-7159": 86746,        # hui
    "takku-rh-2566": 35150,  # Takku·个人(Margin)
}


def realized_events(transactions):
    """[(date10, account, kind, sym, pnl)],按整段历史滚动的已实现事件。
    持仓 key 含 account,避免多账户同 sym 串仓。"""
    txs = sorted(transactions, key=lambda t: t["ts"])
    state = defaultdict(lambda: {"pos": 0.0, "avg": 0.0})
    out = []
    for t in txs:
        acct = t.get("account", "?")
        kind = t.get("kind", "equity")
        key = (acct, kind, t["sym"])
        p = float(t["price"])
        dq = (1.0 if t["side"] == "buy" else -1.0) * float(t["qty"])
        s = state[key]
        pos, avg = s["pos"], s["avg"]
        if pos == 0 or (pos > 0) == (dq > 0):
            newpos = pos + dq
            s["avg"] = (avg * abs(pos) + p * abs(dq)) / abs(newpos) if newpos else 0.0
            s["pos"] = newpos
        else:
            closed = min(abs(dq), abs(pos))
            out.append((t["ts"][:10], acct, kind, t["sym"], closed * (p - avg) * (1 if pos > 0 else -1)))
            newpos = pos + dq
            if abs(dq) > abs(pos):
                s["pos"], s["avg"] = newpos, p
            elif newpos == 0:
                s["pos"], s["avg"] = 0.0, 0.0
            else:
                s["pos"] = newpos
    return out


def _skew(xs):
    n = len(xs)
    if n < 3:
        return None
    m = sum(xs) / n
    s2 = sum((x - m) ** 2 for x in xs) / n
    if s2 == 0:
        return 0.0
    s = math.sqrt(s2)
    return (sum((x - m) ** 3 for x in xs) / n) / (s ** 3)


def _std(xs):
    n = len(xs)
    if n < 2:
        return None
    m = sum(xs) / n
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1))


def window_stats(ev, start=None, as_of=None, capital=0.0):
    """ev: [(date, account, kind, sym, pnl)] 已在窗口内。返回 {metrics, trades}。
    给 start/as_of 时,额外算日已实现 P&L 序列(工作日无交易填0)的波动率/Sharpe/Sortino/最大回撤。
    capital: 账户资本基数,用于把 RISK_FREE_ANNUAL 折成每日美元门槛(rf 与 MAR 同值)。"""
    if not ev:
        return None
    pnls = [e[4] for e in ev]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    bysym = defaultdict(float)
    for _, _, _, sym, pnl in ev:
        bysym[sym] += pnl
    gp = sum(v for v in bysym.values() if v > 0)
    gl = sum(v for v in bysym.values() if v < 0)
    aw = sum(wins) / len(wins) if wins else 0.0
    al = sum(losses) / len(losses) if losses else 0.0
    metrics = {
        "n": len(pnls), "wins": len(wins), "losses": len(losses),
        "win_rate": round(len(wins) / len(pnls), 4),
        "avg_win": round(aw, 2), "avg_loss": round(al, 2),
        "payoff": round(aw / abs(al), 3) if al else None,
        "expectancy": round(sum(pnls) / len(pnls), 2),
        "net": round(sum(pnls), 2), "gross_profit": round(gp, 2), "gross_loss": round(gl, 2),
        "skew": round(_skew(pnls), 3) if _skew(pnls) is not None else None,
        "loss_conc": round(min(bysym.values()) / gl, 4) if gl else None,       # 最大输家/毛亏
        "profit_conc": round(sum(sorted([v for v in bysym.values() if v > 0], reverse=True)[:5]) / gp, 4) if gp else None,
        "max_win": round(max(pnls), 2), "max_loss": round(min(pnls), 2),
    }
    # 日已实现 P&L 序列(窗口内工作日,无交易日填 0)→ 波动率/Sharpe/Sortino/最大回撤。
    # 口径:基于"日已实现美元 P&L"(非账户%收益,无每日净值);rf=MAR=每日$门槛;年化 ×√252。
    if start and as_of:
        by_day = defaultdict(float)
        for d, a, k, s, p in ev:
            by_day[d] += p
        daily, cur, d1 = [], date.fromisoformat(start), date.fromisoformat(as_of)
        while cur <= d1:
            if cur.weekday() < 5:
                daily.append(by_day.get(cur.isoformat(), 0.0))
            cur += timedelta(days=1)
        ann = math.sqrt(TRADING_DAYS)
        rf_daily = (capital or 0.0) * RISK_FREE_ANNUAL / TRADING_DAYS   # 每日$门槛(rf=MAR)
        md = sum(daily) / len(daily) if daily else 0.0
        excess = md - rf_daily                                          # 日均超额(超过门槛)
        sd = _std(daily)                                               # 波动率不因常数门槛而变
        # 下行偏差:以门槛(MAR)为基准,只罚低于门槛的日子
        dd_dev = math.sqrt(sum(min(x - rf_daily, 0.0) ** 2 for x in daily) / len(daily)) if daily else 0.0
        cum = peak = mdd = 0.0
        for x in daily:
            cum += x
            peak = max(peak, cum)
            mdd = min(mdd, cum - peak)
        metrics.update({
            "n_days": len(daily),
            "vol_daily": round(sd, 2) if sd is not None else None,
            "mar_daily": round(rf_daily, 2),                            # 每日$门槛(供展示/核对)
            "sharpe": round(excess / sd * ann, 2) if sd else None,
            "sortino": round(excess / dd_dev * ann, 2) if dd_dev else None,
            "max_dd": round(mdd, 2),
        })
    trades = [{"d": d, "s": s, "k": k, "p": round(p, 2)} for d, a, k, s, p in ev]
    return {"metrics": metrics, "trades": trades}


def emit_json():
    all_ev = []
    labels = {}
    for rf in RAW_FILES:
        p = ROOT / rf
        if not p.exists():
            continue
        d = json.loads(p.read_text())
        for a in d.get("accounts", []):
            labels[a["id"]] = a.get("label", a["id"])
        all_ev += realized_events(d.get("transactions", []))
    if not all_ev:
        print("无可算账户,跳过 pnl.json")
        return
    as_of = max(e[0] for e in all_ev)
    ad = date.fromisoformat(as_of)
    windows = {"ytd": date(ad.year, 1, 1).isoformat(),
               "3m": (ad - timedelta(days=90)).isoformat(),
               "1m": (ad - timedelta(days=30)).isoformat()}
    by_acct = defaultdict(list)
    for e in all_ev:
        by_acct[e[1]].append(e)
    def build_windows(evs, capital):
        w = {}
        for wname, start in windows.items():
            ws = window_stats([e for e in evs if e[0] >= start], start, as_of, capital)
            if ws:
                w[wname] = ws
        return w

    accounts = {}
    for acct, evs in by_acct.items():
        w = build_windows(evs, ACCOUNT_CAPITAL.get(acct, 0.0))
        if w:
            accounts[acct] = {"label": labels.get(acct, acct), "windows": w}
    # "全部"合并视图:跨账户所有已实现事件(资本=各账户资本之和)
    if len(accounts) > 1:
        cap_all = sum(ACCOUNT_CAPITAL.get(a, 0.0) for a in by_acct)
        wall = build_windows(all_ev, cap_all)
        if wall:
            accounts["_all"] = {"label": "全部账户", "windows": wall}
    out = {"updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "as_of": as_of, "risk_free_annual": RISK_FREE_ANNUAL, "accounts": accounts}
    (ROOT / "data/pnl.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"data/pnl.json: {len(accounts)} 账户 · as_of {as_of} · 窗口 {list(windows)}")


def report(path: Path, year: str):
    d = json.loads(path.read_text())
    events = realized_events(d.get("transactions", []))
    per_year = defaultdict(lambda: {"equity": 0.0, "option": 0.0})
    for dt, a, kind, sym, pnl in events:
        per_year[dt[:4]][kind] += pnl
    data_through = max((t["ts"][:10] for t in d.get("transactions", [])), default="—")
    print(f"# takku 已实现盈亏(数据截至 {data_through})\n")
    print("| 年 | 股票 | 期权 | 合计 |\n|---|---:|---:|---:|")
    for y in sorted(per_year):
        e, o = per_year[y]["equity"], per_year[y]["option"]
        print(f"| {y} | {e:+,.0f} | {o:+,.0f} | {e + o:+,.0f} |")
    for y in (sorted(per_year) if year == "all" else [year]):
        ev = [x for x in events if x[0].startswith(y)]
        if not ev:
            continue
        ws = window_stats(ev)["metrics"]
        print(f"\n## {y}: 净 {ws['net']:+,.0f} · 胜率 {ws['win_rate']*100:.0f}% · "
              f"盈亏比 {ws['payoff']} · 偏度 {ws['skew']} · 亏损集中度 {ws['loss_conc']*100:.0f}%")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default="data/_takku_raw.json")
    ap.add_argument("--year", default="2026")
    ap.add_argument("--emit", action="store_true", help="生成 data/pnl.json(公开面板用)")
    a = ap.parse_args()
    if a.emit:
        emit_json()
    else:
        report(ROOT / a.file, a.year)
