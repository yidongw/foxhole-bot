export type AlertLevel = "none" | "watch" | "alert" | "strong";

export interface SignalInput {
  address: string;
  symbol?: string;
  name?: string;
  primaryPair?: string;
  quoteSymbol?: string;
  isStockPaired: boolean;
  volume24hUsd: number;
  liquidityUsd: number;
  fdvUsd?: number;
  priceChange24h?: number;
  quoteLockRatio?: number;
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
