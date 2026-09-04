import { formatUnits, parseUnits, type Address } from "viem";
import { executeSwap, MAINNET_ADDRESSES, parseUsdg } from "hoodchain";

import { getTradingClient } from "../chain/client.js";
import { okxSwap, OkxRouteError } from "../venues/okx/swap.js";
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
 * - `hoodchain` / `okx`: single router, no fallback.
 * - `okx_hood`: try OKX first; fall back to hoodchain **only** on
 *   `OkxRouteError` (OKX failed before broadcasting the swap — no fill
 *   happened, so retrying elsewhere is safe). Any error thrown after the swap
 *   is broadcast propagates unchanged, so we never risk a double fill.
 *
 * Exported for unit testing the routing/fallback decision without live swaps.
 */
export async function runWithFallback<T>(
  router: TradeRouter,
  okxFn: () => Promise<T>,
  hoodFn: () => Promise<T>,
): Promise<T> {
  if (router === "hoodchain") return hoodFn();
  if (router === "okx") return okxFn();
  // okx_hood
  try {
    return await okxFn();
  } catch (err) {
    if (err instanceof OkxRouteError) {
      console.warn(`[trade] OKX 路由不可用,回退 hoodchain:${err.message}`);
      return hoodFn();
    }
    throw err;
  }
}

async function buyViaOkx(
  config: TradeConfig,
  token: Address,
  priceUsd: number,
  usd: number,
): Promise<TradeFill> {
  const { amountOutBase, toDecimals, txHash } = await okxSwap(
    MAINNET_ADDRESSES.usdg as Address,
    token,
    parseUnits(usd.toFixed(USDG_DECIMALS), USDG_DECIMALS),
    config.slippageBps,
  );
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
    () => buyViaOkx(config, token, priceUsd, usd),
    () => buyViaHood(config, token, priceUsd, usd),
  );
}

async function sellViaOkx(
  config: TradeConfig,
  position: Position,
  amountTokens: number,
  currentPriceUsd: number,
): Promise<TradeFill> {
  const { amountOutBase, toDecimals, txHash } = await okxSwap(
    position.token as Address,
    MAINNET_ADDRESSES.usdg as Address,
    parseUnits(amountTokens.toFixed(TOKEN_DECIMALS), TOKEN_DECIMALS),
    config.slippageBps,
  );
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
    () => sellViaOkx(config, position, amountTokens, currentPriceUsd),
    () => sellViaHood(config, position, amountTokens, currentPriceUsd),
  );
}
