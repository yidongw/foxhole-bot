/**
 * Hyperliquid 永续场馆配置。与现货交易 (src/trade/config.ts) 完全独立——
 * 永续有方向(多/空)、杠杆、保证金、资金费、强平,和 ERC-20 现货 swap
 * 不是一套心智模型,所以自成一档 HL_* 环境变量,不复用 TRADE_*。
 *
 * usdPerTrade 语义:**名义敞口(notional)**,不是保证金。保证金 = 名义 / 杠杆。
 * 风控按名义敞口封顶,因为那才是价格波动作用到你身上的规模。
 */

export type HlMode = "off" | "paper" | "live";

export interface HlTakeProfit {
  /** 标的价格朝有利方向变动的百分比(如 10 = +10%)触发该档。 */
  atPricePct: number;
  /** 平掉原始仓位的比例 (0..1]。 */
  closeFraction: number;
}

export interface HlConfig {
  mode: HlMode;
  /** testnet 默认 true——真金前先在测试网跑通全链路。 */
  testnet: boolean;
  /** HIP-3 builder 永续 dex 名(如美股走 trade.xyz);空 = 核心永续。 */
  dex: string;
  /** 每笔名义敞口 (USD)。 */
  usdPerTrade: number;
  /** 调用方不指定时的默认杠杆。 */
  defaultLeverage: number;
  /** 杠杆硬顶,任何请求都不得超过(还会再被该标的的 maxLeverage 夹一次)。 */
  maxLeverage: number;
  /** 保证金模式。做空/新标的建议 isolated,亏损隔离不牵连全账户。 */
  marginMode: "cross" | "isolated";
  maxOpenPerps: number;
  /** 24h 名义敞口累计上限 (USD);<=0 关闭该限制。 */
  maxDailyNotionalUsd: number;
  /** 标的价格逆向变动超过该比例 → 平掉剩余(硬止损,单位为标的价格变动)。 */
  hardStopPct: number;
  /** 从最优价(多头最高/空头最低)回撤该比例 → 移动止损。 */
  trailStopPct: number;
  takeProfits: HlTakeProfit[];
  /** 超过该小时数无条件平仓(避免僵尸仓吃资金费)。 */
  maxHoldHours: number;
  /** 下单模拟市价单的最大滑点(HL 无原生市价单,用激进 IOC 限价单)。 */
  slippageBps: number;
  /** paper 账户起始现金,P&L 以此为基准。 */
  paperStartUsd: number;
  /** agent wallet 私钥(仅 live;无提现权)。 */
  agentKey?: string;
  /** 主账户地址(agent 代签时用于查询/归属)。 */
  accountAddress?: string;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

/** 解析 "10:0.5,25:0.25" → 有利 +10% 平 50%,+25% 再平 25%。 */
function parseTakeProfits(raw: string | undefined): HlTakeProfit[] {
  const src = raw?.trim() || "10:0.5,25:0.25";
  const tiers: HlTakeProfit[] = [];
  for (const part of src.split(",")) {
    const [pct, frac] = part.split(":").map((s) => Number(s.trim()));
    if (Number.isFinite(pct) && Number.isFinite(frac) && pct > 0 && frac > 0) {
      tiers.push({ atPricePct: pct, closeFraction: Math.min(frac, 1) });
    }
  }
  return tiers.sort((a, b) => a.atPricePct - b.atPricePct);
}

export function loadHlConfig(): HlConfig {
  const mode = (process.env.HL_MODE ?? "off") as HlMode;
  const marginMode = (process.env.HL_MARGIN_MODE ?? "isolated") as
    | "cross"
    | "isolated";
  return {
    mode: ["off", "paper", "live"].includes(mode) ? mode : "off",
    testnet: bool("HL_TESTNET", true),
    dex: process.env.HL_DEX?.trim() ?? "",
    usdPerTrade: num("HL_USD_PER_TRADE", 50),
    defaultLeverage: num("HL_DEFAULT_LEVERAGE", 3),
    maxLeverage: num("HL_MAX_LEVERAGE", 5),
    marginMode: marginMode === "cross" ? "cross" : "isolated",
    // <=0 = 不限(与现货 TRADE_MAX_OPEN_POSITIONS 同约定,默认不限)。
    maxOpenPerps: num("HL_MAX_OPEN_PERPS", 0),
    maxDailyNotionalUsd: num("HL_MAX_DAILY_NOTIONAL_USD", 600),
    hardStopPct: num("HL_HARD_STOP_PCT", 0.15),
    trailStopPct: num("HL_TRAIL_STOP_PCT", 0.1),
    takeProfits: parseTakeProfits(process.env.HL_TAKE_PROFITS),
    maxHoldHours: num("HL_MAX_HOLD_HOURS", 72),
    slippageBps: num("HL_SLIPPAGE_BPS", 50),
    paperStartUsd: num("HL_PAPER_START_USD", 1000),
    agentKey: process.env.HL_AGENT_KEY?.trim() || undefined,
    accountAddress: process.env.HL_ACCOUNT_ADDRESS?.trim() || undefined,
  };
}
