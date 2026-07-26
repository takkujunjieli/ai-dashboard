#!/usr/bin/env python3
"""个人回测实验模板(情况二:直接调库、任意信号)。本地脚本,随便改,不 commit。

用法:
  # 取数据(一次)
  git fetch origin data && git show origin/data:data/gex_daily.json > data/gex_daily.json
  # 跑
  python3 scripts/my_bt.py

改这三处就够了:①SYM ②价格来源(可换成自己的 CSV/序列)③my_signal(你的逻辑)。
规则:信号 = 和 prices 等长的 list,取值 {-1,0,+1};第 i 根信号只用下标 ≤ i 的数据(无前视)。
判据:比 null(随机)和 Buy&Hold,且**只信 walk-forward OOS**,别信样本内 total_return。
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from strategy_backtest import run_backtest         # noqa: E402
from strategy_metrics import compute_metrics        # noqa: E402
from strategy_signals import buy_and_hold, random_signals  # noqa: E402
from strategy_walkforward import walk_forward        # noqa: E402

# ============ ① 选票 ============
SYM = "AMD"

# ============ ② 价格 + 时间(任意来源;默认用 gex_daily 日线 spot)============
gd = json.load(open(ROOT / "data" / "gex_daily.json"))
dates = sorted(d for d in gd if SYM in gd.get(d, {}) and gd[d][SYM].get("spot"))
prices = [float(gd[d][SYM]["spot"]) for d in dates]
times = dates
# 换成自己的价格?给两个等长 list 即可,例如读 CSV(列: date, close):
#   import csv; rows = list(csv.DictReader(open("my.csv")))
#   times = [r["date"] for r in rows]; prices = [float(r["close"]) for r in rows]
# gex_daily 每票可用特征(想在信号里用就自己取):
#   net_flow net_nom pcr_vol pcr_oi atm_iv skew_rr iv_term vrp maxpain_pin coverage
FEAT = {f: [gd[d][SYM].get(f) for d in dates]
        for f in ("net_flow", "net_nom", "pcr_oi", "atm_iv", "skew_rr", "iv_term", "vrp")}


# ============ ③ 你的信号:等长 +1/-1/0,只用 ≤i 的数据 ============
def my_signal(px, look=20):
    """示例:20 日动量。价格高于 look 天前 → 做多,低于 → 做空。换成你自己的逻辑。"""
    return [0 if i < look else (1 if px[i] > px[i - look] else -1) for i in range(len(px))]


signals = my_signal(prices)
# 也可以用特征造信号,例如 skew 转正做多:
#   from strategy_signals import sign_signal
#   signals = sign_signal(FEAT["skew_rr"])


# ============ 跑(下面一般不用改)============
def main():
    if len(prices) < 5:
        print(f"{SYM} 样本不足(n={len(prices)});先攒 gex_daily")
        return

    r = run_backtest(prices, signals, times, take_profit_pct=2, stop_loss_pct=1, max_holding_bars=16)
    m = compute_metrics(r, ann_factor=252)
    print(f"== {SYM}  n={len(prices)} ==")
    print(f"单次:  {r['total_trades']} 笔  net {r['total_return_pct']}%  maxDD {r['max_drawdown_pct']}%  "
          f"sharpe {m['sharpe']}  PF {m['profit_factor']}  exposure {m['exposure']}")

    null_r = run_backtest(prices, random_signals(len(prices), 0), times)
    bh = buy_and_hold(prices)
    print(f"对照:  随机null {null_r['total_return_pct']}%   Buy&Hold {bh['total_return_pct']}%   "
          f"→ 跑不赢这俩就没 edge")

    wf = walk_forward(prices, signals, times,
                      grid={"take_profit_pct": [1, 2, 3], "stop_loss_pct": [0.5, 1, 2], "max_holding_bars": [8, 16]},
                      train=40, test=10)
    if wf["n_folds"]:
        print(f"OOS:   {wf['n_folds']} 折  net {wf['oos_total_return_pct']}%  win {wf['oos_win_rate']}%  "
              f"maxDD {wf['oos_max_drawdown_pct']}%   ← 只信这行")
        print(f"       每折选参: {[f['params'] for f in wf['folds']]}")
    else:
        print(f"OOS:   样本不足(需 ≥50 bar,现 {len(prices)});攒够 gex_daily 再看 —— 在此之前上面都是噪声")


if __name__ == "__main__":
    main()
