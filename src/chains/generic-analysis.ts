import { fetchTokenPairs, selectDeepestBasePair, TRUSTED_QUOTE } from "../dex/dexscreener.js";
import { isCredibleQuote } from "../dex/quote-verify.js";
import type { TokenAnalysis } from "../types.js";
import type { ChainId } from "./adapter.js";

// TRUSTED_QUOTE + selectDeepestBasePair moved to ../dex/dexscreener.js so the
// price helpers there can share the junk-pool consensus filter (one-way dep).
export { TRUSTED_QUOTE, selectDeepestBasePair } from "../dex/dexscreener.js";

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
  let primary = selectDeepestBasePair(pairs, address);
  // Credible-quote widening (Stonks 2026-09-04 lesson): the deepest pool is
  // often quoted in a stock token (QQQB/TSLA/…) that the symbol whitelist
  // rejects, so the gate saw $19.9k liquidity while the real deepest pool
  // held ~20x that. If such a pool is DEEPER than the trusted pick, verify
  // its quote token transitively (own trusted depth ≥$1M, or RB registry)
  // and require price consensus with the trusted pick (3x band) before
  // promoting it. Checks at most the top 2 candidates; results are cached
  // 1h per quote address, so steady-state API cost ≈ 0. Not on the 15s
  // manage path (that keeps the sync selector + two-source guards).
  const own = pairs
    .filter((p) => p.baseToken?.address?.toLowerCase() === address.toLowerCase())
    .sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0));
  const primaryLiq = Number(primary?.liquidity?.usd ?? 0);
  const primaryPrice = Number(primary?.priceUsd) || undefined;
  const candidates = own
    .filter(
      (p) =>
        p !== primary &&
        Number(p.liquidity?.usd ?? 0) > primaryLiq &&
        !TRUSTED_QUOTE.has((p.quoteToken?.symbol ?? "").toUpperCase()),
    )
    .slice(0, 2);
  for (const cand of candidates) {
    const px = Number(cand.priceUsd) || undefined;
    const priceConsistent =
      primaryPrice == null || (px != null && px < primaryPrice * 3 && px > primaryPrice / 3);
    if (!priceConsistent) continue;
    if (
      await isCredibleQuote(chain, cand.quoteToken?.address, cand.quoteToken?.symbol)
    ) {
      primary = cand;
      break;
    }
  }
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
    primaryPairAddress: primary.pairAddress,
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
