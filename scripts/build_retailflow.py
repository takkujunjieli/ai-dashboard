#!/usr/bin/env python3
"""把 data/retail_flow_raw.json(+ 可选 data/retail_trends.json)组装成前端用的
data/retailflow.json:每票时间序列 z 化的 RetailNetBuy×RetailIntensity×Attention 复合信号、
前瞻收益(次日/次周)、以及 rank-IC / 散点 / 逐票 IC。纯计算、无网关依赖。

诚实口径:30 天滚动窗口 → IC 只是"指示性"非结论;信号直接按秩用(不拟合,避免过拟合);
方向由中点签名给定;可预测≠可盈利。
"""
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "retail_flow_raw.json"
TRENDS = ROOT / "data" / "retail_trends.json"
OUT = ROOT / "data" / "retailflow.json"


def mean(a):
    return sum(a) / len(a) if a else 0.0


def std(a):
    if len(a) < 2:
        return 0.0
    m = mean(a)
    return (sum((x - m) ** 2 for x in a) / (len(a) - 1)) ** 0.5


def zscore(series):
    """时间序列 z(忽略 None);返回等长列表(None 保留)。"""
    vals = [x for x in series if x is not None]
    m, s = mean(vals), std(vals)
    if s == 0:
        return [0.0 if x is not None else None for x in series]
    return [None if x is None else (x - m) / s for x in series]


def ranks(a):
    """平均秩(处理并列)。"""
    order = sorted(range(len(a)), key=lambda i: a[i])
    r = [0.0] * len(a)
    i = 0
    while i < len(a):
        j = i
        while j < len(a) and a[order[j]] == a[order[i]]:
            j += 1
        avg = (i + j - 1) / 2 + 1
        for k in range(i, j):
            r[order[k]] = avg
        i = j
    return r


def spearman(xs, ys):
    """成对去 None 后的秩相关;不足则 None。"""
    pairs = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    if len(pairs) < 8:
        return None, len(pairs)
    rx, ry = ranks([p[0] for p in pairs]), ranks([p[1] for p in pairs])
    mx, my = mean(rx), mean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = (sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) ** 0.5
    return (num / den if den else None), len(pairs)


def main():
    if not RAW.exists():
        print(f"缺 {RAW};先跑 fetch_tick_flow.py"); return
    raw = json.loads(RAW.read_text())
    days = raw.get("days", {})
    dates = sorted(days.keys())
    if not dates:
        print("raw 无数据"); return
    tickers = sorted({t for d in days.values() for t in d})
    trends = {}
    if TRENDS.exists():
        try:
            trends = json.loads(TRENDS.read_text()).get("data", {})
        except Exception:
            trends = {}

    data = {}
    for tk in tickers:
        nb = [days[d].get(tk, {}).get("netbuy") for d in dates]
        it = [days[d].get(tk, {}).get("intensity") for d in dates]
        px = [days[d].get(tk, {}).get("px") for d in dates]
        at = [trends.get(tk, {}).get(d) for d in dates]
        # 前瞻收益:signal 日 t 的 close → t+1 / t+5 close
        r1 = [None] * len(dates)
        r5 = [None] * len(dates)
        for i in range(len(dates)):
            if px[i]:
                if i + 1 < len(dates) and px[i + 1]:
                    r1[i] = px[i + 1] / px[i] - 1
                if i + 5 < len(dates) and px[i + 5]:
                    r5[i] = px[i + 5] / px[i] - 1
        znb, zit, zat = zscore(nb), zscore(it), zscore(at)
        has_at = any(x is not None for x in at)
        sig = []
        for i in range(len(dates)):
            if znb[i] is None or zit[i] is None or (has_at and zat[i] is None):
                sig.append(None)
            else:
                s = znb[i] * zit[i] * (zat[i] if has_at else 1.0)
                sig.append(round(s, 6))
        data[tk] = {
            "netbuy": nb, "intensity": it, "attention": at if has_at else None,
            "signal": sig, "px": px,
            "ret_1d": [None if x is None else round(x, 6) for x in r1],
            "ret_5d": [None if x is None else round(x, 6) for x in r5],
        }

    # 汇总评估:池化 rank-IC(signal vs 前瞻收益),及 netbuy 单项对照
    def pooled(key, ret_key):
        xs, ys = [], []
        for tk in tickers:
            xs += data[tk][key]; ys += data[tk][ret_key]
        return spearman(xs, ys)
    ic1, n1 = pooled("signal", "ret_1d")
    ic5, n5 = pooled("signal", "ret_5d")
    icnb1, _ = pooled("netbuy", "ret_1d")
    icnb5, _ = pooled("netbuy", "ret_5d")
    per_ticker = {}
    for tk in tickers:
        i1, m1 = spearman(data[tk]["signal"], data[tk]["ret_1d"])
        i5, _ = spearman(data[tk]["signal"], data[tk]["ret_5d"])
        per_ticker[tk] = {"ic_1d": round(i1, 3) if i1 is not None else None,
                          "ic_5d": round(i5, 3) if i5 is not None else None, "n": m1}
    scatter1 = [[data[tk]["signal"][i], data[tk]["ret_1d"][i], tk]
                for tk in tickers for i in range(len(dates))
                if data[tk]["signal"][i] is not None and data[tk]["ret_1d"][i] is not None]
    scatter5 = [[data[tk]["signal"][i], data[tk]["ret_5d"][i], tk]
                for tk in tickers for i in range(len(dates))
                if data[tk]["signal"][i] is not None and data[tk]["ret_5d"][i] is not None]

    out = {
        "topic": "retailflow", "freq": "daily",
        "window_days": raw.get("window_days"), "updated": raw.get("updated"),
        "tickers": tickers, "dates": dates, "data": data,
        "eval": {
            "ic_1d": round(ic1, 3) if ic1 is not None else None,
            "ic_5d": round(ic5, 3) if ic5 is not None else None,
            "ic_netbuy_1d": round(icnb1, 3) if icnb1 is not None else None,
            "ic_netbuy_5d": round(icnb5, 3) if icnb5 is not None else None,
            "n_obs_1d": n1, "n_obs_5d": n5,
            "per_ticker": per_ticker, "scatter_1d": scatter1, "scatter_5d": scatter5,
        },
        "meta": {
            "source": "massive-equity-ticks",
            "netbuy_method": "off-exchange(TRF) sub-penny identify + NBBO-midpoint sign (Barber 2024)",
            "attention": "google-trends" if any(data[tk]["attention"] for tk in tickers) else "none",
            "caveats": [
                "30 天滚动窗口 → IC 指示性、非结论;随天数累积更可信",
                "场外≠纯散户;中点签名残差~5%;可预测≠可盈利(聪明钱会反向)",
                "信号直接按秩用,不拟合(避免小样本过拟合)",
            ],
        },
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"retailflow.json → {OUT.relative_to(ROOT)} ({OUT.stat().st_size/1024:.0f} KB)")
    print(f"  {len(tickers)} 票 × {len(dates)} 天 | IC(1d)={out['eval']['ic_1d']} "
          f"IC(5d)={out['eval']['ic_5d']} | netbuy单项 IC(1d)={out['eval']['ic_netbuy_1d']} "
          f"| n1={n1} n5={n5}")


if __name__ == "__main__":
    main()
