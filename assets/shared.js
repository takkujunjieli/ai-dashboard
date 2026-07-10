/* 信息页与交易页共享的工具函数与数据加载 */

export const REPO = "takkujunjieli/stock-dashboard";

export const $ = (id) => document.getElementById(id);
export const esc = (t) => { const d = document.createElement("div"); d.textContent = t ?? ""; return d.innerHTML; };
export const fmtDT = (iso) => iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—";

export const CAT_LABEL = { news: "新闻", kol: "大V", youtube: "视频", community: "社区" };
export const SENTI = {
  positive: { label: "看多", cls: "senti-pos" },
  negative: { label: "看空", cls: "senti-neg" },
  neutral: { label: "中性", cls: "senti-neu" },
};

export function timeAgo(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
}

export const fmtMoney = (v) => {
  if (v == null) return "—";
  const abs = Math.abs(v);
  const s = abs >= 1e9 ? (abs / 1e9).toFixed(2) + "B" : abs >= 1e6 ? (abs / 1e6).toFixed(1) + "M" : (abs / 1e3).toFixed(0) + "K";
  return (v < 0 ? "-$" : "$") + s;
};
export const fmtNum = (v) => v == null ? "—" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : String(Math.round(v));

/* PAT: 采集控制与认证轮询共用,只存本机浏览器 */
export const getPat = () => localStorage.getItem("ghPat") || "";
export const setPat = (v) => localStorage.setItem("ghPat", v);
export const ghHeaders = (pat) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${pat}`,
});

export async function loadJSON(path) {
  try {
    const r = await fetch(path + "?t=" + Date.now());
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch { return null; }
}

/* 走 GitHub contents API 拿最新提交(采集期间 Pages 不重新部署);
   带 PAT 时认证(5000次/小时),匿名限流 60次/小时;失败退回 Pages 相对路径 */
export async function loadFreshJSON(path) {
  try {
    const headers = { Accept: "application/vnd.github.raw+json" };
    const pat = getPat();
    if (pat) headers.Authorization = `Bearer ${pat}`;
    const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?t=${Date.now()}`, { headers });
    if (r.ok) return await r.json();
  } catch { /* 限流或离线时退回 Pages */ }
  return loadJSON(path);
}
