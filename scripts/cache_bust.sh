#!/usr/bin/env bash
# 部署前给静态资源打版本号(cache-busting)。只改当前工作副本(CI runner 上的 checkout),
# 不提交源码 —— 本地开发照常用裸路径。版本号默认取当前 commit 短 SHA。
# 用法: bash scripts/cache_bust.sh [版本号]
set -euo pipefail
export V="${1:-$(git rev-parse --short HEAD)}"

# 1) HTML 里对 assets/*.css|*.js 的引用追加 ?v=(跳过已带 query 的)
perl -0777 -pi -e 's{(href|src)="(assets/[^"?]+\.(?:css|js))"}{qq{$1="$2?v=$ENV{V}"}}ge' ./*.html

# 2) 入口 JS 内部相对 import(如 ./shared.js)追加 ?v= —— ES module 图需整条链都带版本才不吃旧缓存
perl -0777 -pi -e 's{from\s+"(\./[^"?]+\.js)"}{qq{from "$1?v=$ENV{V}"}}ge' assets/*.js

echo "cache-bust v=$V 已应用"
