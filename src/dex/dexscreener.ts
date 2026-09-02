import type { DexPair } from "../types.js";

const BASE = "https://api.dexscreener.com";

export async function fetchDexJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "User-Agent": "foxhole-bot/0.3" },
  });
  if (!res.ok) {
    throw new Error(`DexScreener ${res.status}: ${path}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchTokenPairs(
  address: string,
  chainId = "robinhood",
): Promise<DexPair[]> {
  const data = await fetchDexJson<{ pairs?: DexPair[] }>(
    `/latest/dex/tokens/${address}`,
  );
  return (data.pairs ?? []).filter((p) => p.chainId === chainId);
}

/** Current USD price from the deepest pair for a token on a chain. */
export async function fetchTokenPriceUsd(
  address: string,
  chainId = "robinhood",
): Promise<number | undefined> {
  const pairs = await fetchTokenPairs(address, chainId);
  const ranked = [...pairs].sort(
    (a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0),
  );
  const price = ranked[0]?.priceUsd;
  return price ? Number(price) : undefined;
}

export async function searchPairs(
  query: string,
  chainId = "robinhood",
): Promise<DexPair[]> {
  const data = await fetchDexJson<{ pairs?: DexPair[] }>(
    `/latest/dex/search?q=${encodeURIComponent(query)}`,
  );
  return (data.pairs ?? []).filter((p) => p.chainId === chainId);
}

export interface BoostedToken {
  chainId: string;
  tokenAddress: string;
  description?: string;
  totalAmount?: number;
  amount?: number;
}

/**
 * Trending candidates: merge latest + top boosts and latest token profiles,
 * dedup by chain+address. Free endpoints, ~30 entries each.
 */
export async function fetchTrendingTokens(chainId: string): Promise<BoostedToken[]> {
  const seen = new Map<string, BoostedToken>();
  for (const path of [
    "/token-boosts/top/v1",
    "/token-boosts/latest/v1",
    "/token-profiles/latest/v1",
  ]) {
    try {
      const items = await fetchDexJson<BoostedToken[]>(path);
      for (const item of items) {
        if (item.chainId !== chainId) continue;
        const key = item.tokenAddress.toLowerCase();
        if (!seen.has(key)) seen.set(key, item);
      }
    } catch (err) {
      console.error(`trending fetch failed ${path}:`, (err as Error).message);
    }
  }
  return [...seen.values()];
}
