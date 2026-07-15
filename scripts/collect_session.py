#!/usr/bin/env python3
"""盘中滚动采集会话:交易时段内按批循环抓取,每批提交一次数据。

行为:
  - 周末直接退出;开盘前(ET 9:30)等待,收盘(ET 16:00)后结束
  - watchlist 按 BATCH 只一批轮转,一批 = 快照 + 1m/5m K线 + 期权链 + GEX;
    指标/short/新闻/日线由 fetch_research 的低频层控制(默认每小时)
  - 每批 git commit + push,前端轮询即可看到最新数据
  - 接近 Actions 单 job 6h 上限时自动续派一个 run 接力

环境变量:
  BATCH(默认 3) · ONCE(true=只跑一轮,不限时段,测试用) · END(UTC ISO,覆盖收盘时间)
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime, time as dtime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
ET = ZoneInfo("America/New_York")
BATCH = int(os.environ.get("BATCH") or 3)
os.environ.setdefault("SKIP_FLOW", "1")  # 盘中滚动跳过重的流量分类,保持轮次快;flow 交 update.yml
ONCE = (os.environ.get("ONCE") or "").lower() == "true"
END_OVERRIDE = (os.environ.get("END") or "").strip()
MAX_SECONDS = 18600  # 5h10m,留出续派与收尾余量(job 上限 6h)

sys.path.insert(0, str(ROOT / "scripts"))
import fetch_research  # noqa: E402
from push_data import push_data  # noqa: E402  盘中高频只推 data 分支

import yaml  # noqa: E402


def sh(*cmd: str) -> int:
    return subprocess.run(cmd, cwd=ROOT).returncode


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def et_at(t: dtime) -> datetime:
    return datetime.combine(datetime.now(ET).date(), t, tzinfo=ET).astimezone(timezone.utc)


def commit_push(msg: str) -> None:
    # 盘中高频数据只推 data 分支(不动 main),让 main 几乎不涨、体积由压平任务控制。
    # main 上的 EOD 基线由 update.yml 维护,仅作前端限流兜底。
    push_data("data", msg)


def main() -> None:
    from _cfg import load_tickers
    watchlist, _ = load_tickers()  # 全量普通组;REST 不限流,一轮全抓,每轮一次提交
    job_start = time.time()

    if ONCE:
        end_utc = None
        print(f"单轮模式: {len(watchlist)} 只")
    else:
        if datetime.now(ET).weekday() >= 5:
            print("周末,不采集")
            return
        open_utc = et_at(dtime(9, 30))
        end_utc = datetime.fromisoformat(END_OVERRIDE.replace("Z", "+00:00")) \
            if END_OVERRIDE else et_at(dtime(16, 0))
        if utc_now() >= end_utc:
            print("已过收盘时间,不采集")
            return
        if utc_now() < open_utc:
            wait = (open_utc - utc_now()).total_seconds()
            print(f"等待开盘 {wait / 60:.0f} 分钟(ET 9:30)")
            time.sleep(wait)
        print(f"滚动采集: {len(watchlist)} 只,至 {end_utc.isoformat(timespec='minutes')}")

    sh("git", "config", "user.name", "github-actions[bot]")
    sh("git", "config", "user.email", "github-actions[bot]@users.noreply.github.com")

    rounds = 0
    while True:
        # 接近单 job 上限,续派一个 run 接力剩余时段
        if not ONCE and time.time() - job_start > MAX_SECONDS:
            print("接近运行上限,续派新 run 接力")
            subprocess.run(["gh", "workflow", "run", "gex.yml",
                            "-R", os.environ.get("GITHUB_REPOSITORY", ""),
                            "-f", f"end={END_OVERRIDE}"], cwd=ROOT)
            return
        t0 = time.time()
        try:
            fetch_research.main(merge=True)  # 全 watchlist,一轮抓完
        except Exception as exc:  # noqa: BLE001 单轮失败不终止会话
            print(f"本轮失败: {fetch_research.redact(exc)}")
        commit_push(f"chore: 滚动采集 {datetime.now(ET).strftime('%H:%M')} (第{rounds + 1}轮)")
        print(f"第{rounds + 1}轮用时 {time.time() - t0:.0f}s")
        rounds += 1
        if ONCE or (end_utc and utc_now() >= end_utc):
            break
    print(f"会话结束,共 {rounds} 轮")


if __name__ == "__main__":
    main()
