/* Portfolio 页:汇集 券商持仓 + 打分(from trading.js)与 风险控制/敞口/组合稳健性(from strategy.js)。
   这些都是本地私有面板(读 gitignored 数据);公开站上相应容器为空。纯拼装,逻辑复用原模块。
   注:import trading.js / strategy.js 会执行其模块顶层,但两者的自启动都已守卫(无本页专有容器时不跑)。 */
import { initPortfolioPanel } from "./trading.js";
import { renderRiskControl, renderRiskExposure, renderRobust } from "./strategy.js";

(async function main() {
  await initPortfolioPanel();   // 💼 持仓 + 打分 + 盈亏诊断
  await renderRiskControl();     // 🛡️ 仓位/风控
  await renderRiskExposure();    // 🌡️ 风险敞口热力图
  await renderRobust();          // 📉 组合稳健性 M2M + β/α
})();
