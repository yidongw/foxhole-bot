export type TradeMode = "off" | "paper" | "live";

export interface TakeProfitTier {
  /** Price multiple of entry that arms this tier. */
  atMultiple: number;
  /** Fraction of the ORIGINAL position to sell. */
  sellFraction: number;
}

export interface TradeConfig {
  mode: TradeMode;
  /** USD notional per entry. */
  usdPerTrade: number;
  /** Hard daily spend cap across all entries (USD). */
  maxDailySpendUsd: number;
  maxOpenPositions: number;
  /** Don't enter tokens thinner than this. */
  minEntryLiquidityUsd: number;
  slippageBps: number;
  /** Exit remaining position when price falls this fraction from its high-water mark. */
  trailStopPct: number;
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
  return {
    mode: ["off", "paper", "live"].includes(mode) ? mode : "off",
    usdPerTrade: num("TRADE_USD_PER_TRADE", 50),
    maxDailySpendUsd: num("TRADE_MAX_DAILY_USD", 200),
    maxOpenPositions: num("TRADE_MAX_OPEN_POSITIONS", 3),
    minEntryLiquidityUsd: num("TRADE_MIN_LIQUIDITY_USD", 50_000),
    slippageBps: num("TRADE_SLIPPAGE_BPS", 100),
    trailStopPct: num("TRADE_TRAIL_STOP_PCT", 0.25),
    hardStopPct: num("TRADE_HARD_STOP_PCT", 0.35),
    takeProfits: [
      { atMultiple: 2, sellFraction: 0.5 },
      { atMultiple: 4, sellFraction: 0.25 },
    ],
    maxHoldHours: num("TRADE_MAX_HOLD_HOURS", 96),
    entryTriggers: (process.env.TRADE_ENTRY_TRIGGERS ??
      "lock_strong,lock_rising_strong,boner_composite")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    denylist: (process.env.TRADE_DENYLIST ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}
