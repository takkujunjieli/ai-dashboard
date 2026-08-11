#!/usr/bin/env python3
"""合并各券商原料 → data/portfolio.json(已公开发布);末尾顺带刷新 data/pnl.json(盈亏诊断)。
原料 data/_*_raw.json 与 portfolio_history.json 仍本地专用不提交。

每个券商写一份已归一的原料 data/_<broker>_raw.json,形如
  {"accounts":[{id,label}...],          # 可选;一个券商下的多个账户
   "positions":[{account,kind,sym,qty,avg_cost,price,mkt_value,pnl,pnl_pct}...],
   "transactions":[{account,kind,ts,sym,side,qty,price,state}...]}
kind: equity(正股,默认)/ option(期权);省略即 equity。做空仓位 qty<0、mkt_value<0。
broker 由文件名推断(_rh_raw.json→rh),可用文件顶层 "broker" 字段覆盖。多账户:在
accounts 里声明 {id,label},每条 position/transaction 带 account=<id>;单账户券商可
省略 accounts 与 account(默认整份归到 id=broker 的单一账户)。本脚本 broker/account
无关:补算缺失字段、合并、按时间排交易,写 portfolio.json(含 accounts 供 UI 下拉);
并 append 一份持仓快照到 portfolio_history.json(供"仓位变动"相邻快照 diff)。纯 stdlib。

多人合并(家庭成员各自独立登录):一人一份 data/_<人名>_raw.json,文件里 "broker":"rh"、
accounts 用带人名的 id/label(如 {"id":"mom-rh","label":"妈妈·个人"})。account id 全局
唯一即可,本脚本按 id 去重合并;UI 下拉即列出全家所有账户,"全部"= 全家合计。

来源:
  Robinhood — Claude 调 robinhood-trading MCP 只读工具,归一后写 data/_rh_raw.json
  moomoo    — scripts/fetch_moomoo.py(OpenD)写 data/_moomoo_raw.json
  家庭成员   — 各人在自己的 Claude/脚本里用自己的登录导出 data/_<人名>_raw.json(同 schema)
"""
import glob
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
TX_KEEP_DAYS = 90        # portfolio.json 只保留最近 N 天的交易明细(≈最近 3 个月)


def _parse_ts(ts):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


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
            "kind": p.get("kind") or "equity",
            "mkt_value": round(mv, 2) if mv is not None else None,
            "pnl": round(pnl, 2) if pnl is not None else None,
            "pnl_pct": round(pct, 4) if pct is not None else None}


def _txn(t: dict) -> dict:
    return {"ts": t.get("ts"), "sym": t.get("sym"),
            "kind": t.get("kind") or "equity",       # equity 正股 / option 期权
            "side": (t.get("side") or "").lower(),
            "qty": _num(t.get("qty")), "price": _num(t.get("price")),
            "state": t.get("state")}


def main() -> None:
    now_dt = datetime.now(timezone.utc)
    now = now_dt.isoformat(timespec="seconds")
    cutoff = now_dt - timedelta(days=TX_KEEP_DAYS)
    positions, transactions, brokers, accounts = [], [], [], []
    seen_acct = set()
    for f in sorted(glob.glob(str(DATA / "_*_raw.json"))):
        broker = Path(f).stem[1:]
        if broker.endswith("_raw"):
            broker = broker[:-4]
        try:
            d = json.loads(Path(f).read_text())
        except (json.JSONDecodeError, OSError) as e:
            print(f"跳过 {Path(f).name}: {e}")
            continue
        broker = d.get("broker") or broker   # 文件可显式声明 broker(如 _mom_raw.json → "rh")
        brokers.append(broker)
        # 账户表:文件可声明 accounts[{id,label}];未声明则该券商作单一账户(id=broker)
        file_accts = d.get("accounts") or [{"id": broker, "label": broker}]
        for a in file_accts:
            aid = a.get("id") or broker
            if aid not in seen_acct:
                seen_acct.add(aid)
                accounts.append({"id": aid, "label": a.get("label") or aid, "broker": broker})
        default_acct = file_accts[0].get("id") if len(file_accts) == 1 else broker
        for p in d.get("positions") or []:
            positions.append({"broker": broker, "account": p.get("account") or default_acct, **_pos(p)})
        for t in d.get("transactions") or []:
            transactions.append({"broker": broker, "account": t.get("account") or default_acct, **_txn(t)})

    # 交易明细只保留最近 TX_KEEP_DAYS 天(ts 缺失/不可解析的丢弃)
    transactions = [t for t in transactions if (pt := _parse_ts(t.get("ts"))) and pt >= cutoff]
    transactions.sort(key=lambda t: t.get("ts") or "", reverse=True)
    out = {"updated_at": now, "brokers": brokers, "accounts": accounts,
           "positions": positions, "transactions": transactions}
    (DATA / "portfolio.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))

    hp = DATA / "portfolio_history.json"
    hist = json.loads(hp.read_text()) if hp.exists() else {"snapshots": []}
    hist["snapshots"].append({"ts": now, "positions": [
        {"broker": p["broker"], "account": p.get("account"), "sym": p["sym"],
         "qty": p.get("qty"), "mkt_value": p.get("mkt_value")}
        for p in positions]})
    hist["snapshots"] = hist["snapshots"][-200:]
    hp.write_text(json.dumps(hist, ensure_ascii=False, indent=1))

    print(f"portfolio.json: {len(positions)} 持仓 / {len(transactions)} 交易 · "
          f"账户 {[a['id'] for a in accounts] or '(无原料)'}")

    # 顺带刷新盈亏诊断(公开 data/pnl.json,供面板)。引擎独立、只对有完整历史的账户出;
    # 失败不影响持仓构建。要更新公开站,build 后照常 commit + push + deploy。
    try:
        import analyze_pnl
        analyze_pnl.emit_json()
    except Exception as e:  # noqa: BLE001
        print(f"pnl.json 生成跳过: {e}")


if __name__ == "__main__":
    main()
