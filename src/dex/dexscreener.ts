import type { DexPair } from "../types.js";

const BASE = "https://api.dexscreener.com";

/**
 * DexScreener fetch with 429/5xx backoff. Under full multi-chain review load
 * DexScreener rate-limits, and a missing response silently dropped `fdv` —
 * which made the mcap gate fail open (keep-on-unknown let junk through). Retry
 * so `fdv` is reliably present. Backoff: 0.5s, 1s, 2s.
 */
/**
 * Self-inflicted 429 storms (841 rate-limit hits on 09-05: scanner + engine +
 * decider + four review loops sharing one IP against DexScreener's ~300/min
 * cap) stretched engine ticks to minutes and fed degraded responses into the
 * phantom-price incidents. Every module funnels through this function, so
 * robustness lives here:
 *   1. token bucket (240/min, under the cap) — we stop DDoSing ourselves;
 *   2. in-flight dedupe — concurrent identical GETs share one request
 *      (scanner/engine/reviews constantly ask for the same hot tokens);
 *   3. 10s response cache — sub-tick TTL, so exits still see fresh prices.
 */
const BUCKET_CAPACITY = 240;
let bucketTokens = BUCKET_CAPACITY;
let bucketRefillAt = Date.now();
const RESPONSE_TTL_MS = 10_000;
const responseCache = new Map<string, { at: number; data: unknown }>();
const inFlight = new Map<string, Promise<unknown>>();

async function takeBucketToken(): Promise<void> {
  for (;;) {
    const now = Date.now();
    const elapsed = now - bucketRefillAt;
    if (elapsed > 0) {
      bucketTokens = Math.min(
        BUCKET_CAPACITY,
        bucketTokens + (elapsed / 60_000) * BUCKET_CAPACITY,
      );
      bucketRefillAt = now;
    }
    if (bucketTokens >= 1) {
      bucketTokens -= 1;
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function fetchDexJson<T>(path: string, retries = 3): Promise<T> {
  const hit = responseCache.get(path);
  if (hit && Date.now() - hit.at < RESPONSE_TTL_MS) return hit.data as T;
  const pending = inFlight.get(path);
  if (pending) return pending as Promise<T>;

  const run = (async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      await takeBucketToken();
      try {
        const res = await fetch(`${BASE}${path}`, {
          headers: { "User-Agent": "foxhole-bot/0.3" },
        });
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          lastErr = new Error(`DexScreener ${res.status}: ${path}`);
          continue;
        }
        if (!res.ok) throw new Error(`DexScreener ${res.status}: ${path}`);
        const data = (await res.json()) as T;
        responseCache.set(path, { at: Date.now(), data });
        if (responseCache.size > 500) {
          for (const [k, v] of responseCache) {
            if (Date.now() - v.at > RESPONSE_TTL_MS) responseCache.delete(k);
          }
        }
        return data;
      } catch (err) {
        lastErr = err;
        if (attempt >= retries) break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`DexScreener failed: ${path}`);
  })();
  inFlight.set(path, run);
  try {
    return await run;
  } finally {
    inFlight.delete(path);
  }
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

/** Real quote assets whose USD price DexScreener can be trusted. A pool quoted
 *  against a JUNK token (e.g. memestock/GMEB with $40M fake liquidity) reports a
 *  fabricated USD price — 100x+ off the real WBNB/USDT-quoted pools, which fed a
 *  bogus "118x 卖飞" and can corrupt entry FDV / exit management. */
export const TRUSTED_QUOTE = new Set([
  "WBNB", "BNB", "USDT", "USDC", "USD1", "BUSD", "USDB", "DAI",
  "WETH", "ETH", "SOL", "WSOL", "USDG", "WBTC", "BTCB",
  // Tokenized-stock quotes that themselves hold DEEP real liquidity vs USDT and
  // are redeemable — the "币股 meme" sector pairs against these, so excluding
  // them blinded the liquidity gate and made risk-control reject every probe
  // (Stonks/QQQB: real $329k main pool invisible, decider tried to buy 4× and
  // was rejected on the $34k USDT edge pool → missed a +389% move). The price-
  // consensus guard below still rejects any fake-priced pool that spoofs these.
  "QQQB",
]);

/**
 * Deepest pair where the token is the BASE side (quote-side pairs belong to
 * the other token — see the HIMS/BONER regression on Robinhood), PREFERRING
 * pools quoted in a real asset so a junk-quote fake-liquidity pool can't hand
 * us a fabricated USD price. Falls back to deepest overall if none are trusted.
 */
export function selectDeepestBasePair(
  pairs: DexPair[],
  address: string,
): DexPair | undefined {
  const own = pairs.filter(
    (p) => p.baseToken?.address?.toLowerCase() === address.toLowerCase(),
  );
  const byLiq = (a: DexPair, b: DexPair) =>
    Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0);
  const trusted = own.filter((p) =>
    TRUSTED_QUOTE.has((p.quoteToken?.symbol ?? "").toUpperCase()),
  );
  const cands = [...(trusted.length ? trusted : own)].sort(byLiq);
  if (cands.length <= 1) return cands[0];

  // Price consensus: a junk pool can fake liquidity AND a trusted quote
  // SYMBOL (symbols are free strings — a fake "USDT" passes TRUSTED_QUOTE),
  // but it can't move every other pool's price. MarsCoin 2026-09-04: a pool
  // claiming $1.8M liq priced the token at $149-153 vs $0.12 on the real
  // pancake pools — it won the deepest-liquidity sort, booked $25k of phantom
  // exit proceeds and poisoned the high-water mark. Reject candidates whose
  // price is >3x off the median of priced candidates, then take the deepest
  // survivor. Median uses the lower-middle on even counts, biasing against
  // fake-HIGH pools (the profitable-looking direction for phantom exits);
  // fake-LOW reads are still caught by the engine's downside glitch guard.
  const prices = cands
    .map((p) => Number(p.priceUsd))
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  if (prices.length >= 2) {
    const median = prices[Math.floor((prices.length - 1) / 2)];
    const sane = cands.filter((p) => {
      const px = Number(p.priceUsd);
      if (!(px > 0)) return true; // unpriced pools keep old behavior
      return px <= median * 3 && px >= median / 3;
    });
    if (sane.length) return sane[0];
  }
  return cands[0];
}

/** Current USD price from the deepest pair for a token on a chain. */
export async function fetchTokenPriceUsd(
  address: string,
  chainId = "robinhood",
): Promise<number | undefined> {
  // Same junk-pool-resistant selection as everywhere else — a naive
  // deepest-liquidity sort here fed the GME entry at $0.01249 (real $0.0022,
  // -82% "hard stop" 8s after open) and the MarsCoin $149 phantom reads.
  const pairs = await fetchTokenPairs(address, chainId);
  const price = selectDeepestBasePair(pairs, address)?.priceUsd;
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
