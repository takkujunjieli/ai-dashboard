"""标的配置加载:优先 config/tickers.json,回退旧的 watchlist.yml。

tickers.json 是唯一来源(由交易台 UI 编辑):
  watchlist — 全集(行情/新闻/财报)
  deep      — 深度子集(K线/期权/GEX/指标),缺省等于 watchlist
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_tickers() -> tuple[list[str], list[str]]:
    """返回 (watchlist, deep)。deep 会被裁剪到 watchlist 内并去重保序。"""
    j = ROOT / "config" / "tickers.json"
    if j.exists():
        cfg = json.loads(j.read_text())
        watchlist = [t for t in cfg.get("watchlist", []) if isinstance(t, str)]
        deep_raw = cfg.get("deep") or watchlist
    else:  # 回退旧配置
        import yaml
        watchlist = yaml.safe_load((ROOT / "config" / "watchlist.yml").read_text())["tickers"]
        deep_raw = watchlist
    wl_set = set(watchlist)
    seen, deep = set(), []
    for t in deep_raw:
        if t in wl_set and t not in seen:
            seen.add(t)
            deep.append(t)
    return watchlist, (deep or watchlist)
