import type { Address } from "viem";

export interface DexPair {
  chainId?: string;
  url?: string;
  pairAddress?: string;
  labels?: string[];
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  fdv?: number;
  liquidity?: { usd?: number; base?: number; quote?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  pairCreatedAt?: number;
  txns?: { h24?: { buys?: number; sells?: number } };
}

export interface LaunchRecord {
  address: string;
  name?: string;
  symbol?: string;
  pair: string;
  quote_symbol: string;
  quote_address?: string;
  fdv: number;
  liquidity_usd: number;
  volume_24h: number;
  price_usd: number;
  price_change_24h?: number;
  pair_created_at?: number | null;
  dex_url?: string;
  labels: string[];
  txns_24h: number;
  created_at?: string | null;
  long_url: string;
  explorer_url: string;
  source: string;
  launchpad: string;
  launch_time_source?: string;
}

export interface LaunchesPayload {
  meta: {
    fetched_at: string;
    chain: string;
    chain_id: number;
    launchpad: string;
    factory: string;
    airlock: string;
    source: string;
    count: number;
    quote_breakdown: Record<string, number>;
    total_volume_24h_usd: number;
    total_liquidity_usd: number;
  };
  launches: LaunchRecord[];
}

export interface TokenAnalysis {
  /** EVM checksummed address or Solana base58 mint. */
  address: string;
  /** Chain this analysis belongs to (default robinhood for legacy callers). */
  chain?: string;
  symbol?: string;
  name?: string;
  primaryPair?: string;
  /** DexScreener pairAddress of the primary pair (usable as DexPaprika pool id). */
  primaryPairAddress?: string;
  priceUsd?: number;
  fdvUsd?: number;
  volume24hUsd?: number;
  liquidityUsd?: number;
  priceChange24h?: number;
  launchAt?: string;
  pairs: Array<{
    pair: string;
    liquidityUsd: number;
    volume24h: number;
    createdAt?: string;
  }>;
  quoteLockRatio?: number;
  /** Launchpad bonding-curve progress 0..1 (pump.fun etc.). */
  curveProgress?: number;
  curveGraduated?: boolean;
  quoteSymbol?: string;
  quoteTotalSupply?: string;
  quoteLockedInPool?: string;
  stockOracleUsd?: number;
  onchainQuoteUsd?: number;
  quotePremium?: number;
  signals: string[];
}
