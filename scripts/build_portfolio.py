#!/usr/bin/env python3
"""合并各券商原料 → data/portfolio.json(本地专用,gitignored,绝不提交)。

每个券商写一份已归一的原料 data/_<broker>_raw.json,形如
  {"positions":[{sym,qty,avg_cost,price,mkt_value,pnl,pnl_pct}...],
   "transactions":[{ts,sym,side,qty,price,state}...]}
broker 由文件名推断(_rh_raw.json→rh)。本脚本 broker 无关:补算缺失字段、合并、
按时间排交易,写 portfolio.json;并 append 一份持仓快照到 portfolio_history.json
(供"仓位变动"相邻快照 diff)。纯 stdlib。

来源:
  Robinhood — Claude 调 robinhood-trading MCP 只读工具,归一后写 data/_rh_raw.json
  moomoo    — scripts/fetch_moomoo.py(OpenD)写 data/_moomoo_raw.json
"""
import glob
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _pos(p: dict) -> dict:
    qty, cost, price = _num(p.get("qty")), _num(p.get("avg_cost")), _num(p.get("price"))
    mv = _num(p.get("mkt_value"))
    if mv is None and qty is not None and price is not None:
        mv = qty * price
    pnl = _num(p.get("pnl"))
    if pnl is None and None not in (qty, cost, price):
        pnl = qty * (price - cost)
    pct = _num(p.get("pnl_pct"))
    if pct is None and pnl is not None and cost and qty and cost * qty:
        pct = pnl / (cost * qty)
    return {"sym": p.get("sym"), "qty": qty, "avg_cost": cost, "price": price,
            "mkt_value": round(mv, 2) if mv is not None else None,
            "pnl": round(pnl, 2) if pnl is not None else None,
            "pnl_pct": round(pct, 4) if pct is not None else None}


def _txn(t: dict) -> dict:
    return {"ts": t.get("ts"), "sym": t.get("sym"),
            "side": (t.get("side") or "").lower(),
            "qty": _num(t.get("qty")), "price": _num(t.get("price")),
            "state": t.get("state")}


def main() -> None:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    positions, transactions, brokers = [], [], []
    for f in sorted(glob.glob(str(DATA / "_*_raw.json"))):
        broker = Path(f).stem[1:]
        if broker.endswith("_raw"):
            broker = broker[:-4]
        try:
            d = json.loads(Path(f).read_text())
        except (json.JSONDecodeError, OSError) as e:
            print(f"跳过 {Path(f).name}: {e}")
            continue
        brokers.append(broker)
        for p in d.get("positions") or []:
            positions.append({"broker": broker, **_pos(p)})
        for t in d.get("transactions") or []:
            transactions.append({"broker": broker, **_txn(t)})

    transactions.sort(key=lambda t: t.get("ts") or "", reverse=True)
    out = {"updated_at": now, "brokers": brokers,
           "positions": positions, "transactions": transactions}
    (DATA / "portfolio.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))

    hp = DATA / "portfolio_history.json"
    hist = json.loads(hp.read_text()) if hp.exists() else {"snapshots": []}
    hist["snapshots"].append({"ts": now, "positions": [
        {"broker": p["broker"], "sym": p["sym"], "qty": p.get("qty"), "mkt_value": p.get("mkt_value")}
        for p in positions]})
    hist["snapshots"] = hist["snapshots"][-200:]
    hp.write_text(json.dumps(hist, ensure_ascii=False, indent=1))

    print(f"portfolio.json: {len(positions)} 持仓 / {len(transactions)} 交易 · 券商 {brokers or '(无原料)'}")


if __name__ == "__main__":
    main()
