$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$private = Resolve-Path "..\stock-dashboard-private" -ErrorAction SilentlyContinue
if (-not $private) {
  throw "缺 ..\stock-dashboard-private -- 先把私有库 clone 到 noetic-dashboard 的同级目录"
}
$private = $private.Path

New-Item -ItemType Directory -Force -Path "data", "config", "research", "scripts" | Out-Null

function Link-PrivateFile($local, $name) {
  $target = Join-Path $private $name
  if (-not (Test-Path -LiteralPath $target)) { return }
  if (Test-Path -LiteralPath $local) { Remove-Item -LiteralPath $local -Force }
  New-Item -ItemType HardLink -Path $local -Target $target | Out-Null
  Write-Output "  $local -> private/$name"
}

@(
  "_rh_raw.json",
  "_takku_raw.json",
  "portfolio.json",
  "pnl.json",
  "portfolio_history.json",
  "monthly_returns.json",
  "trade_journal.json",
  "risk_stops.json",
  "completed_theses.json",
  "thesis_events.json",
  "atr.json",
  "robustness.json",
  ".px_cache.json",
  "rh_networth.json"
) | ForEach-Object { Link-PrivateFile "data\$_" $_ }

Link-PrivateFile "config\risk_policy.json" "risk_policy.json"

Write-Output "done. Start local server: python3 -m http.server 8000"
