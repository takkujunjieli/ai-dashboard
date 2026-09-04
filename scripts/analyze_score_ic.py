#!/usr/bin/env python3
"""Scorecard → forward-return rank-IC(信息系数)研究。

原理:每次 build_scorecards.py 运行都会把当日打分追加到
research/scorecards/_score_history.json(每天一条快照)。本脚本对每个快照日 d:
  1. 取该日各 ticker 的聚合分 mean(等权 4 维)作为「预测变量」;
  2. 用价格缓存 data/.px_cache.json 算各 ticker 从 d 起 H 个交易日的 forward return;
  3. 做横截面 Spearman 秩相关 → 得到该日的 IC(打分排序 vs 后续收益排序的一致性);
再把各快照日的 IC 求均值 = 平均 IC,并算 t 值(mean/std·√n_dates)衡量是否稳定为正。
IC>0 = 打分对后续相对收益有正预测力;≈0 = 打分与运气无异;<0 = 反指。

关键:forward return 需要「未来」价格,所以刚开始记录时每个 horizon 都会
"样本不足"(status=insufficient),需累计 ≥ MIN_DATES 个快照日、且各日已过 H 交易日
才给出可信 IC。这是设计使然,不是 bug —— 防止我用极少样本自欺。

输出 data/score_ic.json(gitignore,本地专用)。非投资建议。"""
import json
import math
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HIST = ROOT / "research" / "scorecards" / "_score_history.json"
PXCACHE = ROOT / "data" / ".px_cache.json"
OUT = ROOT / "data" / "score_ic.json"

HORIZONS = [5, 10, 21]      # 交易日:约 1 周 / 2 周 / 1 月
MIN_DATES = 3               # 少于这么多个有效快照日 → 不给 IC(样本不足)


def _spearman(xs, ys):
    """Spearman 秩相关(平均秩处理并列),纯 stdlib。返回 None 若样本 < 3 或无方差。"""
    n = len(xs)
    if n < 3:
        return None

    def ranks(v):
        order = sorted(range(n), key=lambda i: v[i])
        r = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j + 1 < n and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2.0 + 1.0            # 并列取平均秩
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r

    rx, ry = ranks(xs), ranks(ys)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((rx[i] - mx) * (ry[i] - my) for i in range(n))
    dx = math.sqrt(sum((rx[i] - mx) ** 2 for i in range(n)))
    dy = math.sqrt(sum((ry[i] - my) ** 2 for i in range(n)))
    if dx == 0 or dy == 0:
        return None
    return num / (dx * dy)


def _fwd_return(series_dates, series_px, d, h):
    """series_* = 该 ticker 已排序的 (dates, closes)。返回 d 起 h 个交易日的收益,或 None。"""
    lo, n = 0, len(series_dates)
    # 第一个 >= d 的交易日
    while lo < n and series_dates[lo] < d:
        lo += 1
    if lo >= n or lo + h >= n:
        return None
    p0, p1 = series_px[lo], series_px[lo + h]
    if p0 is None or p1 is None or p0 <= 0:
        return None
    return p1 / p0 - 1.0


def main():
    result = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "min_dates": MIN_DATES,
        "horizons": {},
        "n_snapshots": 0,
        "notes": [],
    }
    if not HIST.exists():
        result["notes"].append("无打分历史(_score_history.json 不存在);先跑 build_scorecards.py。")
        OUT.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
        print("无打分历史,写空结果。")
        return

    history = json.loads(HIST.read_text(encoding="utf-8"))
    px = json.loads(PXCACHE.read_text(encoding="utf-8")).get("prices", {}) if PXCACHE.exists() else {}
    result["n_snapshots"] = len(history)
    snap_dates = sorted(history.keys())

    # 预排序每个 ticker 的价格序列
    px_sorted = {}
    for sym, m in px.items():
        ds = sorted(m.keys())
        px_sorted[sym] = (ds, [m[x] for x in ds])

    feats = None
    missing = set()
    for d in snap_dates:
        feats = history[d].get("features", feats)

    for h in HORIZONS:
        per_date_ic = []            # 聚合分(mean)的每日 IC
        per_feat_ic = {}            # 各维单独的每日 IC 列表
        covered = 0
        for d in snap_dates:
            snap = history[d]["scores"]
            xs_mean, ys, per_feat_x = [], [], {}
            for tk, rec in snap.items():
                ser = px_sorted.get(tk)
                if not ser:
                    missing.add(tk)
                    continue
                fr = _fwd_return(ser[0], ser[1], d, h)
                if fr is None:
                    continue
                xs_mean.append(rec["mean"])
                ys.append(fr)
                for f, v in rec["scores"].items():
                    per_feat_x.setdefault(f, [[], []])
                    per_feat_x[f][0].append(v)
                    per_feat_x[f][1].append(fr)
            ic = _spearman(xs_mean, ys)
            if ic is not None:
                per_date_ic.append(ic)
                covered += 1
                for f, (fx, fy) in per_feat_x.items():
                    fic = _spearman(fx, fy)
                    if fic is not None:
                        per_feat_ic.setdefault(f, []).append(fic)

        entry = {"horizon_td": h, "n_dates_usable": covered}
        if covered < MIN_DATES:
            entry["status"] = "insufficient"
            entry["reason"] = (f"仅 {covered} 个快照日已过 {h} 交易日(需 ≥{MIN_DATES})。"
                               "继续每日记录,时间会累积。")
        else:
            n = len(per_date_ic)
            mean_ic = sum(per_date_ic) / n
            std = math.sqrt(sum((x - mean_ic) ** 2 for x in per_date_ic) / (n - 1)) if n > 1 else 0.0
            entry["status"] = "ok"
            entry["ic_mean"] = round(mean_ic, 4)
            entry["ic_std"] = round(std, 4)
            entry["ic_t"] = round(mean_ic / std * math.sqrt(n), 3) if std > 0 else None
            entry["ir"] = round(mean_ic / std, 3) if std > 0 else None
            entry["per_feature_ic"] = {
                f: round(sum(v) / len(v), 4) for f, v in sorted(per_feat_ic.items())
            }
        result["horizons"][str(h)] = entry

    if missing:
        result["notes"].append("价格缓存缺失、未计入 IC 的 ticker:" + ", ".join(sorted(missing)))
    if all(e["status"] == "insufficient" for e in result["horizons"].values()):
        result["notes"].append(
            f"当前所有 horizon 样本不足(共 {len(history)} 个快照日)。"
            "每天跑一次打分即累积一条;最快的 5 交易日 IC 约需一周多后开始有值。")

    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"score IC → {OUT}  快照 {len(history)} 天")
    for h, e in result["horizons"].items():
        if e["status"] == "ok":
            print(f"  {h}td: IC={e['ic_mean']:+.3f}  t={e['ic_t']}  (n={e['n_dates_usable']} 日)")
        else:
            print(f"  {h}td: 样本不足({e['n_dates_usable']} 日)")


if __name__ == "__main__":
    main()
