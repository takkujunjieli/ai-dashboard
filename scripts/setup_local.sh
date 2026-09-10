#!/usr/bin/env bash
# 一键重建本地私有符号链接。换机器时:把 noetic-dashboard 和 stock-dashboard-private(私有库)
# clone 到同级目录,再在 noetic-dashboard 根运行 `bash scripts/setup_local.sh`。
# 所有私有数据(持仓/盈亏/打分/复盘/止损)都存在 stock-dashboard-private(私有库),
# 此脚本把它们链接进本仓库供本地服务器读;公开站永远看不到这些(gitignored)。
set -e
cd "$(dirname "$0")/.."
PRIV="../stock-dashboard-private"
[ -d "$PRIV" ] || { echo "✗ 缺 $PRIV —— 先把私有库 clone 到 noetic-dashboard 的同级目录"; exit 1; }
mkdir -p data config research scripts
for f in _rh_raw.json _takku_raw.json portfolio.json pnl.json portfolio_history.json monthly_returns.json trade_journal.json risk_stops.json completed_theses.json thesis_events.json atr.json robustness.json .px_cache.json rh_networth.json; do
  [ -e "$PRIV/$f" ] || continue
  ln -sfn "../../stock-dashboard-private/$f" "data/$f" && echo "  data/$f → private/$f"
done
ln -sfn ../stock-dashboard-private/risk_policy.json config/risk_policy.json && echo "  config/risk_policy.json → private/risk_policy.json"
ln -sfn ../../stock-dashboard-private/scorecards research/scorecards && echo "  research/scorecards → private/scorecards"
[ -e "$PRIV/build_scorecards.py" ] && ln -sfn ../../stock-dashboard-private/build_scorecards.py scripts/build_scorecards.py && echo "  scripts/build_scorecards.py → private/build_scorecards.py"
echo "✓ 完成。起本地服务: python3 -m http.server 8000  → http://localhost:8000/portfolio.html"
