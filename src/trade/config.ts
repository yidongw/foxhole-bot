export type TradeMode = "off" | "paper" | "live";

/**
 * live 下单路由。仅影响 live 模式;paper 都不下真单。带 `_hood` 后缀的会在
 * 主路由**广播前**失败(RouteError:API 挂/无路由/授权/模拟 revert)时回退
 * hoodchain;swap 一旦广播就不回退,避免重复下单。
 * - `hoodchain` = 直连 RB Uniswap v3(默认,历史行为;只认 v3 池)。
 * - `lifi` / `lifi_hood` = LI.FI 聚合器(实测 RB 真能执行、覆盖 v4,首选)。
 * - `okx` / `okx_hood` = OKX 聚合器(RB 目前 quote-only、执行 revert,留待 OKX 修复)。
 */
export type TradeRouter =
  | "hoodchain"
  | "okx"
  | "okx_hood"
  | "lifi"
  | "lifi_hood";

export interface TakeProfitTier {
  /** Price multiple of entry that arms this tier. */
  atMultiple: number;
  /** Fraction of the ORIGINAL position to sell. */
  sellFraction: number;
}

export interface TradeConfig {
  mode: TradeMode;
  /** live 下单路由:hoodchain(默认)| okx。 */
  router: TradeRouter;
  /** USD notional per entry. */
  usdPerTrade: number;
  /** Hard 24h capital-at-risk cap across entries (USD); <=0 disables it. */
  maxDailySpendUsd: number;
  /** Paper account starting cash (USD) — the balance we track P&L against. */
  paperStartUsd: number;
  /**
   * Mechanically auto-enter on every trade-grade signal. Default OFF: the
   * AI decider is the sole buyer, so its skip/buy judgement is authoritative
   * (the engine still manages exits/stops mechanically). When this was on,
   * the engine bought "I" one minute after the decider posted "跳过" to the
   * thread — the analysis had no power over execution.
   */
  autoEntry: boolean;
  maxOpenPositions: number;
  /** Don't enter tokens thinner than this. */
  minEntryLiquidityUsd: number;
  /**
   * Relaxed liquidity floor for smart-money-triggered signals on early launches.
   * RB-chain new pools typically open at $15k–$25k liquidity and grow fast;
   * the standard $50k floor systematically blocks these before they move.
   * Only applies when the signal has a `smart_money` trigger.
   */
  minEntryLiquiditySmartMoneyUsd: number;
  /**
   * Stricter liquidity floor for pure momentum signals (momentum_strong without
   * lock/boner/curve confirmation). Momentum-only signals are higher noise and
   * can fire well into a pump; $100k filters out thin pools mid-pump.
   */
  minEntryLiquidityMomentumUsd: number;
  slippageBps: number;
  /** Exit remaining position when price falls this fraction from its high-water mark. */
  trailStopPct: number;
  /**
   * Trail stop arms only once high-water ≥ entry × this multiple. Arming at
   * any tick above entry (the old `highWater > entry`) turned routine early
   * volatility into guaranteed scratch-outs: NUDES #1 topped at +21%, then a
   * normal 25% wiggle off that high force-closed the position at -15% — hours
   * before the real move. Below the arm threshold only the hard stop guards.
   */
  trailArmMultiple: number;
  /** Exit everything when price falls this fraction below entry. */
  hardStopPct: number;
  takeProfits: TakeProfitTier[];
  /** Close stale positions after this many hours regardless of P&L. */
  maxHoldHours: number;
  /** Signal triggers that qualify as entries. */
  entryTriggers: string[];
  denylist: string[];
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadTradeConfig(): TradeConfig {
  const mode = (process.env.TRADE_MODE ?? "off") as TradeMode;
  const router = (process.env.TRADE_ROUTER ?? "hoodchain") as TradeRouter;
  return {
    mode: ["off", "paper", "live"].includes(mode) ? mode : "off",
    router: (
      ["hoodchain", "okx", "okx_hood", "lifi", "lifi_hood"] as const
    ).includes(router)
      ? router
      : "hoodchain",
    usdPerTrade: num("TRADE_USD_PER_TRADE", 50),
    // <=0 disables (default since 2026-09-04: AI sizes/paces buys itself;
    // paper cash is the only remaining bound).
    maxDailySpendUsd: num("TRADE_MAX_DAILY_USD", 0),
    paperStartUsd: num("TRADE_PAPER_START_USD", 1000),
    autoEntry: process.env.TRADE_AUTO_ENTRY === "1",
    // <=0 = unlimited. Default unlimited (2026-09-04): slots kept blocking
    // entries at 3/3 while risk is already bounded by the 24h capital cap.
    maxOpenPositions: num("TRADE_MAX_OPEN_POSITIONS", 0),
    minEntryLiquidityUsd: num("TRADE_MIN_LIQUIDITY_USD", 50_000),
    minEntryLiquiditySmartMoneyUsd: num("TRADE_MIN_LIQUIDITY_SMART_MONEY_USD", 15_000),
    minEntryLiquidityMomentumUsd: num("TRADE_MIN_LIQUIDITY_MOMENTUM_USD", 100_000),
    slippageBps: num("TRADE_SLIPPAGE_BPS", 100),
    trailStopPct: num("TRADE_TRAIL_STOP_PCT", 0.25),
    trailArmMultiple: num("TRADE_TRAIL_ARM_MULT", 1.5),
    hardStopPct: num("TRADE_HARD_STOP_PCT", 0.35),
    // Fat-tail-shaped ladder: take a small de-risk bite early, then leave a
    // large 45% moonbag riding the trailing stop so mega-runners (NUDES-type
    // 10x+) aren't capped at ~2-3x. The old 2x→50% / 4x→25% ladder was
    // base-hit calibration — it banked half the position before the move that
    // pays for every stopped-out loser had a chance to happen.
    takeProfits: [
      { atMultiple: 2, sellFraction: 0.33 },
      { atMultiple: 4, sellFraction: 0.22 },
    ],
    maxHoldHours: num("TRADE_MAX_HOLD_HOURS", 96),
    entryTriggers: (process.env.TRADE_ENTRY_TRIGGERS ??
      "lock_strong,lock_rising_strong,boner_composite,curve_near_grad_strong,ai_decision,momentum_strong")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    denylist: (process.env.TRADE_DENYLIST ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}
