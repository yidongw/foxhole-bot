import type { DexPair } from "../types.js";

const BASE = "https://api.dexscreener.com";

/**
 * DexScreener fetch with 429/5xx backoff. Under full multi-chain review load
 * DexScreener rate-limits, and a missing response silently dropped `fdv` —
 * which made the mcap gate fail open (keep-on-unknown let junk through). Retry
 * so `fdv` is reliably present. Backoff: 0.5s, 1s, 2s.
 */
export async function fetchDexJson<T>(path: string, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { "User-Agent": "foxhole-bot/0.3" },
      });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        lastErr = new Error(`DexScreener ${res.status}: ${path}`);
        continue;
      }
      if (!res.ok) throw new Error(`DexScreener ${res.status}: ${path}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`DexScreener failed: ${path}`);
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
