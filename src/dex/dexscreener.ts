import type { DexPair } from "../types.js";

const BASE = "https://api.dexscreener.com/latest/dex";

export async function fetchDexJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "User-Agent": "foxhole-bot/0.2" },
  });
  if (!res.ok) {
    throw new Error(`DexScreener ${res.status}: ${path}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchTokenPairs(address: string): Promise<DexPair[]> {
  const data = await fetchDexJson<{ pairs?: DexPair[] }>(
    `/tokens/${address}`,
  );
  return (data.pairs ?? []).filter((p) => p.chainId === "robinhood");
}

/** Current USD price from the deepest Robinhood Chain pair for a token. */
export async function fetchTokenPriceUsd(
  address: string,
): Promise<number | undefined> {
  const pairs = await fetchTokenPairs(address);
  const ranked = [...pairs].sort(
    (a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0),
  );
  const price = ranked[0]?.priceUsd;
  return price ? Number(price) : undefined;
}

export async function searchPairs(query: string): Promise<DexPair[]> {
  const data = await fetchDexJson<{ pairs?: DexPair[] }>(`/search?q=${encodeURIComponent(query)}`);
  return (data.pairs ?? []).filter((p) => p.chainId === "robinhood");
}
