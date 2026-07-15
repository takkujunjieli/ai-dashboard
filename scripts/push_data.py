#!/usr/bin/env python3
"""把当前 data/ 快照提交到指定分支(默认 data),用独立 git worktree 完成,
不扰动主检出(main)。

设计:盘中高频采集(每天十几次)只推 data 分支,让 main 几乎不涨;
data 分支的历史体积由每周的「压平 data 分支」workflow 定期重置为单条提交。
前端主数据源读 data 分支(contents API + ?ref=data),main 上的 EOD 基线仅作限流兜底。

用法: python scripts/push_data.py [branch] [message]
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WT = ROOT.parent / ".data-branch-wt"  # 兄弟目录,避免落在 data/ 里被自我包含


def sh(*cmd: str, cwd: Path = ROOT) -> int:
    return subprocess.run(cmd, cwd=cwd).returncode


def push_data(branch: str = "data", msg: str = "chore: update data") -> bool:
    """把 ROOT/data 的当前内容作为一次提交推到远端 branch。返回是否真的推了。"""
    data_dir = ROOT / "data"
    if not data_dir.is_dir():
        print("no data/ dir"); return False

    sh("git", "config", "http.postBuffer", "524288000")  # 避免大包 HTTP 400
    sh("git", "fetch", "-q", "origin", branch)
    # 清掉可能残留的旧 worktree(prune 清注册表,再删目录;都静默)
    sh("git", "worktree", "prune")
    if WT.exists():
        sh("git", "worktree", "remove", "--force", str(WT))
        shutil.rmtree(WT, ignore_errors=True)
    # 基于远端 branch 在独立 worktree 里建/重置本地同名分支
    if sh("git", "worktree", "add", "--force", "-B", branch, str(WT), f"origin/{branch}") != 0:
        print(f"worktree add {branch} 失败"); return False

    try:
        dst = WT / "data"
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(data_dir, dst)
        sh("git", "add", "data", cwd=WT)
        if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=WT).returncode == 0:
            print("data 无变化,跳过"); return False
        sh("git", "commit", "-q", "-m", msg, cwd=WT)
        if sh("git", "push", "-q", "origin", branch, cwd=WT) != 0:
            # 撞车(如与 EOD 镜像/压平任务并发):以本次数据为准 rebase 后重推
            sh("git", "pull", "--rebase", "-X", "theirs", "-q", "origin", branch, cwd=WT)
            sh("git", "push", "-q", "origin", branch, cwd=WT)
        print(f"已推送 data/ -> {branch}")
        return True
    finally:
        sh("git", "worktree", "remove", "--force", str(WT))


if __name__ == "__main__":
    b = sys.argv[1] if len(sys.argv) > 1 else "data"
    m = sys.argv[2] if len(sys.argv) > 2 else "chore: update data"
    push_data(b, m)
