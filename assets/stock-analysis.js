/* 个股分析页:Scorecards(打分表,复用 trading.js 的渲染)。打分数据本地私有(gitignored,
   经符号链接指向私有库),公开站相应容器为空。import trading.js 会执行其模块顶层,
   但其自启动已守卫(无 #chart 不跑),故此处安全复用。 */
import { initScorecards } from "./trading.js";

initScorecards();
