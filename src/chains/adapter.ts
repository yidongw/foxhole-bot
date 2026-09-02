import type { TokenAnalysis } from "../types.js";
import type { TradeConfig } from "../trade/config.js";
import type { TradeFill } from "../trade/execute.js";
import type { Position } from "../trade/positions.js";

export type ChainId = "robinhood" | "solana" | "bsc" | "base" | "ethereum";

export const ALL_CHAINS: ChainId[] = [
  "robinhood",
  "solana",
  "bsc",
  "base",
  "ethereum",
];

export const CHAIN_TAG: Record<ChainId, string> = {
  robinhood: "RB",
  solana: "SOL",
  bsc: "BSC",
  base: "BASE",
  ethereum: "ETH",
};

export interface ChainAdapter {
  id: ChainId;
  displayName: string;
  /** Trending/candidate tokens to analyze this tick (already deduped). */
  trendingCandidates(): Promise<string[]>;
  /** Full analysis: generic market data + any chain-specific extras. */
  analyze(address: string): Promise<TokenAnalysis>;
  priceUsd(address: string): Promise<number | undefined>;
  /** Live execution. Absent = monitor/paper only (live entries rejected). */
  buy?(
    token: string,
    priceUsd: number,
    usd: number,
    config: TradeConfig,
  ): Promise<TradeFill>;
  sell?(
    position: Position,
    fraction: number,
    currentPriceUsd: number,
    config: TradeConfig,
  ): Promise<TradeFill>;
}

/** Chains enabled for monitoring, from CHAINS env (default robinhood only). */
export function enabledChains(): ChainId[] {
  const raw = process.env.CHAINS ?? "robinhood";
  const ids = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is ChainId => (ALL_CHAINS as string[]).includes(s));
  return ids.length ? ids : ["robinhood"];
}

/** Chains allowed to open trades, from TRADE_CHAINS env (default robinhood). */
export function tradeEnabledChains(): ChainId[] {
  const raw = process.env.TRADE_CHAINS ?? "robinhood";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is ChainId => (ALL_CHAINS as string[]).includes(s));
}
