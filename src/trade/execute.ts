import { formatUnits, parseUnits, type Address } from "viem";
import { executeSwap, MAINNET_ADDRESSES, parseUsdg } from "hoodchain";

import { getTradingClient } from "../chain/client.js";
import { RouteError } from "../venues/route-error.js";
import { okxSwap } from "../venues/okx/swap.js";
import { lifiSwap } from "../venues/lifi/swap.js";
import type { TradeConfig, TradeRouter } from "./config.js";
import type { Position } from "./positions.js";

/** Long.xyz memes are DERC20s with 18 decimals. */
const TOKEN_DECIMALS = 18;
/** USDG on RB chain is 6 decimals. */
const USDG_DECIMALS = 6;

export interface TradeFill {
  priceUsd: number;
  amountTokens: number;
  proceedsUsd?: number;
  txHash?: string;
}

/**
 * Run a live fill through the configured router, with optional fallback.
 *
 * - `hoodchain`: hoodchain only (primary ignored).
 * - `okx` / `lifi`: that aggregator only, no fallback.
 * - `okx_hood` / `lifi_hood` (any `_hood` suffix): try the primary aggregator;
 *   fall back to hoodchain **only** on a `RouteError` (the primary failed
 *   before broadcasting the swap — no fill happened, so retrying elsewhere is
 *   safe). Errors thrown after the swap is broadcast propagate unchanged, so
 *   we never risk a double fill.
 *
 * Exported for unit testing the routing/fallback decision without live swaps.
 */
export async function runWithFallback<T>(
  router: TradeRouter,
  primaryFn: () => Promise<T>,
  hoodFn: () => Promise<T>,
): Promise<T> {
  if (router === "hoodchain") return hoodFn();
  if (!router.endsWith("_hood")) return primaryFn();
  try {
    return await primaryFn();
  } catch (err) {
    if (err instanceof RouteError) {
      console.warn(`[trade] 主路由不可用(${router}),回退 hoodchain:${err.message}`);
      return hoodFn();
    }
    throw err;
  }
}

/** Pick the aggregator swap fn for a router; hoodchain routers never reach here. */
function primarySwap(
  router: TradeRouter,
  aggAmountIn: bigint,
  fromToken: Address,
  toToken: Address,
  slippageBps: number,
) {
  const okx = () => okxSwap(fromToken, toToken, aggAmountIn, slippageBps);
  const lifi = () => lifiSwap(fromToken, toToken, aggAmountIn, slippageBps);
  return router.startsWith("lifi") ? lifi : okx;
}

async function buyViaAgg(
  config: TradeConfig,
  token: Address,
  priceUsd: number,
  usd: number,
): Promise<TradeFill> {
  const swap = primarySwap(
    config.router,
    parseUnits(usd.toFixed(USDG_DECIMALS), USDG_DECIMALS),
    MAINNET_ADDRESSES.usdg as Address,
    token,
    config.slippageBps,
  );
  const { amountOutBase, toDecimals, txHash } = await swap();
  const amountTokens = Number(formatUnits(amountOutBase, toDecimals));
  return {
    priceUsd: amountTokens > 0 ? usd / amountTokens : priceUsd,
    amountTokens,
    txHash,
  };
}

async function buyViaHood(
  config: TradeConfig,
  token: Address,
  priceUsd: number,
  usd: number,
): Promise<TradeFill> {
  const client = getTradingClient();
  const { hash, quote } = await executeSwap(
    client,
    {
      tokenIn: MAINNET_ADDRESSES.usdg,
      tokenOut: token,
      amountIn: parseUsdg(usd.toFixed(6)),
    },
    { slippageBps: config.slippageBps },
  );
  const amountTokens = Number(formatUnits(quote.amountOut, TOKEN_DECIMALS));
  return {
    priceUsd: amountTokens > 0 ? usd / amountTokens : priceUsd,
    amountTokens,
    txHash: hash,
  };
}

/**
 * Buy `usd` worth of `token`.
 * Paper mode fills at the observed DexScreener price with zero slippage —
 * optimistic by design; live results will be worse.
 *
 * Live mode routes USDG → token per `config.router` (hoodchain v3 direct, OKX
 * aggregator, or OKX-primary-with-hoodchain-fallback). hoodchain only sees
 * Uniswap v3 pools, so it raises NoRouteError on v4-only tokens; OKX covers
 * v4 too — that's the reason to prefer okx / okx_hood for RB-chain memes.
 */
export async function buy(
  config: TradeConfig,
  token: Address,
  priceUsd: number,
  usd: number,
): Promise<TradeFill> {
  if (config.mode === "paper") {
    return { priceUsd, amountTokens: usd / priceUsd };
  }
  return runWithFallback(
    config.router,
    () => buyViaAgg(config, token, priceUsd, usd),
    () => buyViaHood(config, token, priceUsd, usd),
  );
}

async function sellViaAgg(
  config: TradeConfig,
  position: Position,
  amountTokens: number,
  currentPriceUsd: number,
): Promise<TradeFill> {
  const swap = primarySwap(
    config.router,
    parseUnits(amountTokens.toFixed(TOKEN_DECIMALS), TOKEN_DECIMALS),
    position.token as Address,
    MAINNET_ADDRESSES.usdg as Address,
    config.slippageBps,
  );
  const { amountOutBase, toDecimals, txHash } = await swap();
  const proceedsUsd = Number(formatUnits(amountOutBase, toDecimals));
  return {
    priceUsd: amountTokens > 0 ? proceedsUsd / amountTokens : currentPriceUsd,
    amountTokens,
    proceedsUsd,
    txHash,
  };
}

async function sellViaHood(
  config: TradeConfig,
  position: Position,
  amountTokens: number,
  currentPriceUsd: number,
): Promise<TradeFill> {
  const client = getTradingClient();
  const { hash, quote } = await executeSwap(
    client,
    {
      tokenIn: position.token as Address,
      tokenOut: MAINNET_ADDRESSES.usdg,
      amountIn: parseUnits(amountTokens.toFixed(TOKEN_DECIMALS), TOKEN_DECIMALS),
    },
    { slippageBps: config.slippageBps },
  );
  const proceedsUsd = Number(formatUnits(quote.amountOut, USDG_DECIMALS));
  return {
    priceUsd: amountTokens > 0 ? proceedsUsd / amountTokens : currentPriceUsd,
    amountTokens,
    proceedsUsd,
    txHash: hash,
  };
}

/** Sell `fraction` of the position's original token amount. */
export async function sell(
  config: TradeConfig,
  position: Position,
  fraction: number,
  currentPriceUsd: number,
): Promise<TradeFill> {
  const amountTokens = position.amountTokens * fraction;

  if (config.mode === "paper") {
    return {
      priceUsd: currentPriceUsd,
      amountTokens,
      proceedsUsd: amountTokens * currentPriceUsd,
    };
  }
  return runWithFallback(
    config.router,
    () => sellViaAgg(config, position, amountTokens, currentPriceUsd),
    () => sellViaHood(config, position, amountTokens, currentPriceUsd),
  );
}
