export type AlertLevel = "none" | "watch" | "alert" | "strong";

export interface SignalInput {
  address: string;
  /** Chain id (default robinhood). */
  chain?: string;
  symbol?: string;
  name?: string;
  primaryPair?: string;
  /** DexScreener pairAddress (DexPaprika pool id) of the primary pair. */
  primaryPairAddress?: string;
  quoteSymbol?: string;
  isStockPaired: boolean;
  priceUsd?: number;
  volume24hUsd: number;
  liquidityUsd: number;
  fdvUsd?: number;
  priceChange24h?: number;
  quoteLockRatio?: number;
  /** Lock ratio change vs the previous monitor snapshot (percentage points, 0-1 scale). */
  quoteLockDelta?: number;
  /** Launchpad bonding-curve progress 0..1 (graduation at 1). */
  curveProgress?: number;
  curveGraduated?: boolean;
  quotePremium?: number;
  /** Max pair volume / avg other pair volume on same token. */
  volumeSpikeRatio?: number;
  /** Current vol / last monitor snapshot vol. */
  volumeAccelRatio?: number;
  daysSinceLaunch?: number;
  launchAt?: string;
  dexUrl?: string;
  longUrl?: string;
}

export interface SignalEvaluation {
  level: AlertLevel;
  score: number;
  reasons: string[];
  triggers: string[];
  input: SignalInput;
}

export interface BacktestCase {
  id: string;
  label: string;
  date: string;
  description: string;
  input: SignalInput;
  /** Minimum level expected — backtest fails if actual < expected. */
  minLevel: AlertLevel;
  /** Must NOT exceed this level (optional guard for early flat periods). */
  maxLevel?: AlertLevel;
}

export const LEVEL_RANK: Record<AlertLevel, number> = {
  none: 0,
  watch: 1,
  alert: 2,
  strong: 3,
};
