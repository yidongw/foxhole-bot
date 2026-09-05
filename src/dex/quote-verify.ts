import { fetchDexJson, TRUSTED_QUOTE } from "./dexscreener.js";
import type { DexPair } from "../types.js";
import { fetchStockRegistry } from "../chains/robinhood/stock-registry.js";

/**
 * Transitive quote-token trust (user-designed, 2026-09-05): a quote token
 * whose OWN pools hold >$1M of TRUSTED-quoted liquidity cannot cheaply fake
 * its USD price — arbitrage anchors it — so pools quoted in it are credible
 * for liquidity/price purposes even though its SYMBOL is not whitelisted.
 *
 * Validated against three real cases:
 *   real QQQB (bsc 0x2058…)  $3.17M trusted own-depth → credible ✓
 *     (Stonks/QQQB, the deepest pool, was invisible to the gate and the
 *      signal reported $19.9k liquidity while real depth was ~20x that)
 *   GMEB (memestock's $44M fake-liquidity attack quote)  $418k → rejected ✓
 *   fake QQQB (bsc 0x1fde…)  $8k → rejected ✓
 *
 * The $1M bar therefore doubles as an attack-cost floor: faking a credible
 * quote requires locking $1M of real assets. ADDRESS-level only — same-name
 * junk quotes are everywhere.
 *
 * Cost: zero LLM; one DexScreener call per UNIQUE unknown quote address with
 * a 60-min in-memory cache (the per-chain stock-token quote universe is a few
 * dozen entries, so steady-state extra API load ≈ 0). Robinhood short-circuits
 * through the already-cached official stock registry (no API call at all).
 * Fails CLOSED (unknown/unreachable = not credible) — this widens vision,
 * never the attack surface. NOT used on the engine's 15s manage path.
 */

export const CREDIBLE_QUOTE_MIN_TRUSTED_LIQ_USD = 1_000_000;

const cache = new Map<string, { credible: boolean; at: number }>();
const TTL_MS = 60 * 60_000;

/** Sum of the quote token's OWN liquidity held in TRUSTED-symbol pools. */
export function trustedOwnLiquidityUsd(
  pairs: DexPair[],
  quoteAddr: string,
): number {
  let sum = 0;
  for (const p of pairs) {
    if (p.baseToken?.address?.toLowerCase() !== quoteAddr.toLowerCase()) continue;
    if (!TRUSTED_QUOTE.has((p.quoteToken?.symbol ?? "").toUpperCase())) continue;
    sum += Number(p.liquidity?.usd ?? 0);
  }
  return sum;
}

export async function isCredibleQuote(
  chain: string,
  quoteAddr: string | undefined,
  quoteSymbol?: string,
): Promise<boolean> {
  if (!quoteAddr) return false;
  // Symbol whitelist stays the fast path for the classic quotes.
  if (quoteSymbol && TRUSTED_QUOTE.has(quoteSymbol.toUpperCase())) return true;
  const key = `${chain}:${quoteAddr.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.credible;

  let credible = false;
  try {
    if (chain === "robinhood") {
      // Official tokenized stocks: registry membership (address-level, cached
      // upstream) IS the credibility proof — no extra API call.
      const reg = await fetchStockRegistry();
      credible = reg?.addresses.has(quoteAddr.toLowerCase()) ?? false;
    } else {
      const res = await fetchDexJson<{ pairs?: DexPair[] }>(
        `/latest/dex/tokens/${quoteAddr}`,
      );
      credible =
        trustedOwnLiquidityUsd(res.pairs ?? [], quoteAddr) >=
        CREDIBLE_QUOTE_MIN_TRUSTED_LIQ_USD;
    }
  } catch {
    credible = false; // fail closed
  }
  cache.set(key, { credible, at: Date.now() });
  return credible;
}
