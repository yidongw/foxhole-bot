import { fetchTokenPairs } from "../dex/dexscreener.js";
import type { DexPair, TokenAnalysis } from "../types.js";
import type { ChainId } from "./adapter.js";

/**
 * Deepest pair where the token is the BASE side (quote-side pairs belong to
 * the other token — see the HIMS/BONER regression on Robinhood).
 */
export function selectDeepestBasePair(
  pairs: DexPair[],
  address: string,
): DexPair | undefined {
  const own = pairs.filter(
    (p) => p.baseToken?.address?.toLowerCase() === address.toLowerCase(),
  );
  return [...own].sort(
    (a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0),
  )[0];
}

/**
 * Chain-agnostic DexScreener analysis: market data + volume/momentum signals.
 * No Robinhood extras (lock ratio, oracle premium) — adapters add their own.
 */
export async function analyzeTokenGeneric(
  chain: ChainId,
  address: string,
): Promise<TokenAnalysis> {
  const pairs = await fetchTokenPairs(address, chain);
  if (!pairs.length) {
    throw new Error(`No ${chain} pairs found for ${address}`);
  }
  const primary = selectDeepestBasePair(pairs, address);
  if (!primary) {
    throw new Error(`${address} only appears as a quote token on ${chain}`);
  }

  const base = primary.baseToken;
  const quoteSymbol = primary.quoteToken?.symbol ?? "?";
  const volume24h = Number(primary.volume?.h24 ?? 0);
  const signals: string[] = [];

  const avgOtherVol =
    pairs
      .filter((p) => p.pairAddress !== primary.pairAddress)
      .reduce((sum, p) => sum + Number(p.volume?.h24 ?? 0), 0) /
    Math.max(pairs.length - 1, 1);
  if (volume24h > avgOtherVol * 5 && volume24h > 100_000) {
    signals.push("24h volume spike vs other pairs");
  }
  if ((primary.priceChange?.h24 ?? 0) >= 30) {
    signals.push(`price +${primary.priceChange?.h24?.toFixed(0)}% 24h`);
  }

  return {
    address,
    chain,
    symbol: base?.symbol,
    name: base?.name,
    primaryPair: `${base?.symbol}/${quoteSymbol}`,
    priceUsd: primary.priceUsd ? Number(primary.priceUsd) : undefined,
    fdvUsd: primary.fdv,
    volume24hUsd: volume24h,
    liquidityUsd: Number(primary.liquidity?.usd ?? 0),
    priceChange24h: primary.priceChange?.h24,
    launchAt: primary.pairCreatedAt
      ? new Date(primary.pairCreatedAt).toISOString()
      : undefined,
    pairs: pairs
      .sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))
      .map((p) => ({
        pair: `${p.baseToken?.symbol}/${p.quoteToken?.symbol}`,
        liquidityUsd: Number(p.liquidity?.usd ?? 0),
        volume24h: Number(p.volume?.h24 ?? 0),
        createdAt: p.pairCreatedAt
          ? new Date(p.pairCreatedAt).toISOString()
          : undefined,
      })),
    quoteSymbol,
    signals,
  };
}
