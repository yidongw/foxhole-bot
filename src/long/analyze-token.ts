import type { Address } from "viem";
import { getAddress, isAddress } from "viem";

import { fetchTokenPairs } from "../dex/dexscreener.js";
import {
  getErc20Balance,
  getErc20TotalSupply,
  getStockOracleUsd,
} from "../chain/client.js";
import { formatPct, formatUsd } from "../lib/utils.js";
import type { DexPair, TokenAnalysis } from "../types.js";

const STOCK_TOKEN_DECIMALS = 18;

function isEvmAddress(value: string | undefined): value is Address {
  return Boolean(value && isAddress(value));
}

/** Uniswap v4 pools use a bytes32 pool id — not an ERC-20 holder address. */
function poolHolderAddress(pair: DexPair): Address | undefined {
  if (isEvmAddress(pair.pairAddress)) return getAddress(pair.pairAddress);
  return undefined;
}

function lockedQuoteFromDex(pair: DexPair): bigint | undefined {
  const quote = pair.liquidity?.quote;
  if (quote == null || quote <= 0) return undefined;
  // DexScreener reports human-readable token amounts.
  return BigInt(Math.round(quote * 10 ** STOCK_TOKEN_DECIMALS));
}

/**
 * Deepest pair where the analyzed token is the BASE. Pairs where it appears
 * as the quote (e.g. analyzing HIMS and finding BONER/HIMS) belong to the
 * other token — using them attributes the meme's stats to its stock pair.
 */
export function selectPrimaryPair(
  pairs: DexPair[],
  address: Address,
): DexPair | undefined {
  const own = pairs.filter(
    (p) => p.baseToken?.address?.toLowerCase() === address.toLowerCase(),
  );
  const stockPairs = own.filter((p) => {
    const q = p.quoteToken?.symbol ?? "";
    return !["ETH", "WETH", "USDG", "USDC", "USDT"].includes(q);
  });
  const ranked = [...(stockPairs.length ? stockPairs : own)].sort(
    (a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0),
  );
  return ranked[0];
}

export async function analyzeToken(addressInput: string): Promise<TokenAnalysis> {
  if (!isAddress(addressInput)) {
    throw new Error(`Invalid address: ${addressInput}`);
  }
  const address = getAddress(addressInput);
  const pairs = await fetchTokenPairs(address);
  if (!pairs.length) {
    throw new Error(`No Robinhood Chain pairs found for ${address}`);
  }

  const primary = selectPrimaryPair(pairs, address);
  if (!primary) {
    throw new Error(
      `${address} only appears as a quote token — likely a stock token, not a launch`,
    );
  }
  const base = primary.baseToken;
  const quote = primary.quoteToken;
  const quoteSymbol = quote?.symbol ?? "?";
  const quoteAddress = isEvmAddress(quote?.address)
    ? getAddress(quote.address)
    : undefined;
  const poolAddress = poolHolderAddress(primary);

  const signals: string[] = [];
  let quoteLockRatio: number | undefined;
  let quoteTotalSupply: string | undefined;
  let quoteLockedInPool: string | undefined;
  let stockOracleUsd: number | undefined;
  let onchainQuoteUsd: number | undefined;
  let quotePremium: number | undefined;

  if (quoteAddress) {
    try {
      const total = await getErc20TotalSupply(quoteAddress);
      quoteTotalSupply = total.toString();

      let locked: bigint | undefined;
      if (poolAddress) {
        locked = await getErc20Balance(quoteAddress, poolAddress);
      } else {
        locked = lockedQuoteFromDex(primary);
        if (locked != null) {
          signals.push("quote lock from DexScreener (v4 pool — no holder address)");
        }
      }

      if (locked != null) {
        quoteLockedInPool = locked.toString();
        if (total > 0n) {
          quoteLockRatio = Number(locked) / Number(total);
          if (quoteLockRatio >= 0.5) signals.push("quote lock ≥50% (squeeze risk)");
          else if (quoteLockRatio >= 0.3) signals.push("quote lock ≥30% (tightening)");
        }
      }
    } catch (err) {
      signals.push(`on-chain lock read failed: ${(err as Error).message}`);
    }
  }

  stockOracleUsd = await getStockOracleUsd(quoteSymbol);
  const quoteUsdPair = pairs.find(
    (p) =>
      p.baseToken?.symbol === quoteSymbol &&
      ["USDG", "USDC", "USDT"].includes(p.quoteToken?.symbol ?? ""),
  );
  if (quoteUsdPair?.priceUsd) {
    onchainQuoteUsd = Number(quoteUsdPair.priceUsd);
    if (stockOracleUsd && onchainQuoteUsd > 0) {
      quotePremium = onchainQuoteUsd / stockOracleUsd;
      if (quotePremium >= 1.5) {
        signals.push(`quote premium ${quotePremium.toFixed(2)}x vs oracle`);
      }
    }
  }

  const volume24h = Number(primary.volume?.h24 ?? 0);
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
    chain: "robinhood",
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
    quoteLockRatio,
    quoteSymbol,
    quoteTotalSupply,
    quoteLockedInPool,
    stockOracleUsd,
    onchainQuoteUsd,
    quotePremium,
    signals,
  };
}

export function formatAnalysisReport(a: TokenAnalysis): string {
  const lines = [
    `${a.name ?? a.symbol ?? "Token"} (${a.symbol ?? "?"})`,
    `Address: ${a.address}`,
    `Primary pair: ${a.primaryPair ?? "—"}`,
    `Launch: ${a.launchAt ?? "—"}`,
    `FDV: ${formatUsd(a.fdvUsd)} | 24h vol: ${formatUsd(a.volume24hUsd)} | Liq: ${formatUsd(a.liquidityUsd)}`,
    `24h: ${formatPct(a.priceChange24h)}`,
    "",
    "Quote lock (BONER-style squeeze signal):",
    `  ${a.quoteSymbol}: ${a.quoteLockRatio != null ? `${(a.quoteLockRatio * 100).toFixed(1)}%` : "—"} locked in primary pool`,
    `  Oracle ${a.quoteSymbol}: ${formatUsd(a.stockOracleUsd)} | On-chain: ${formatUsd(a.onchainQuoteUsd)} | Premium: ${a.quotePremium != null ? `${a.quotePremium.toFixed(2)}x` : "—"}`,
    "",
    "Signals:",
    ...(a.signals.length ? a.signals.map((s) => `  • ${s}`) : ["  • none"]),
    "",
    "All pairs:",
    ...a.pairs.map(
      (p) =>
        `  ${p.pair} — liq ${formatUsd(p.liquidityUsd)}, vol ${formatUsd(p.volume24h)}${p.createdAt ? `, since ${p.createdAt}` : ""}`,
    ),
  ];
  return lines.join("\n");
}
