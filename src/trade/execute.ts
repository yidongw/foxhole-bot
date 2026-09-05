import { formatUnits, parseUnits, type Address } from "viem";
import { executeSwap, MAINNET_ADDRESSES, parseUsdg } from "hoodchain";

import { getErc20Balance, getTradingClient } from "../chain/client.js";
import { RouteError } from "../venues/route-error.js";
import { okxSwap } from "../venues/okx/swap.js";
import { kyberSwap } from "../venues/kyber/swap.js";
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
 * - `okx_hood` / `lifi_hood` / `lifi_okx_hood` (any `_hood` suffix): try the
 *   router's aggregator chain (see `primarySwap`); fall back to hoodchain
 *   **only** on a `RouteError` (the aggregators failed before broadcasting the
 *   swap — no fill happened, so retrying elsewhere is safe). Errors thrown after
 *   the swap is broadcast propagate unchanged, so we never risk a double fill.
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

type AggKind = "lifi" | "okx" | "kyber";
const AGG_KINDS: AggKind[] = ["lifi", "okx", "kyber"];

/**
 * Aggregators to attempt, in the order they appear in the router string
 * (e.g. `lifi_kyber_okx_hood` → [lifi, kyber, okx]). Unknown segments (like the
 * trailing `hood`) are ignored — the `_hood` fallback is handled separately.
 */
function aggChain(router: TradeRouter): AggKind[] {
  return router
    .split("_")
    .filter((p): p is AggKind => (AGG_KINDS as string[]).includes(p));
}

/**
 * Build a swap fn that walks the router's aggregator chain in order, moving to
 * the next aggregator on a `RouteError` (pre-broadcast failure — no fill, safe
 * to retry). A post-broadcast error propagates immediately (never a double
 * fill). If every aggregator `RouteError`s, the last one is rethrown so the
 * caller's hoodchain fallback (via `runWithFallback`) can take over.
 *
 * The Kyber/OKX legs cover pools LI.FI won't route: UFG's v4/native pool
 * (quote-only on LI.FI) and ORDO-class tokens only one aggregator can sell.
 * Those are fresh, hyper-volatile launches, so any *fallback* leg (i>0 — LI.FI
 * already declined) uses the wider `fallbackSlippageBps` floor — the tight
 * primary slippage makes them revert "Min return not reached" / slippage on
 * exactly the tokens they're there to rescue. The primary leg keeps tight
 * slippage, so normal tokens are unaffected.
 */
function primarySwap(
  router: TradeRouter,
  aggAmountIn: bigint,
  fromToken: Address,
  toToken: Address,
  slippageBps: number,
  fallbackSlippageBps: number,
) {
  const chain = aggChain(router);
  return async () => {
    let lastErr: unknown;
    for (let i = 0; i < chain.length; i++) {
      const kind = chain[i];
      const slip = i > 0 ? Math.max(slippageBps, fallbackSlippageBps) : slippageBps;
      try {
        if (kind === "lifi") return await lifiSwap(fromToken, toToken, aggAmountIn, slip);
        if (kind === "kyber") return await kyberSwap(fromToken, toToken, aggAmountIn, slip);
        return await okxSwap(fromToken, toToken, aggAmountIn, slip);
      } catch (err) {
        if (err instanceof RouteError) {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new RouteError("no aggregator route available");
  };
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
    config.aggFallbackSlippageBps,
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
    config.aggFallbackSlippageBps,
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

/**
 * Clamp a live sell to what the wallet actually holds.
 *
 * The ledger stores the *quoted* fill size (`quote.amountOut`), but the wallet
 * receives the post-slippage amount, so `position.amountTokens` runs slightly
 * ahead of the real balance. Asking the router to sell more than we hold makes
 * its `transferFrom` fail and the whole swap reverts with `STF` — which on
 * 2026-09-05 silently blocked *every* live RB exit (ROBINCAT ledger 830.3357 vs
 * chain 830.2488; GRASS 1151.9191 vs 1149.2892), so stop-losses and trailing
 * stops fired for hours with nothing ever getting sold.
 *
 * Clamping (rather than only fixing the buy-side bookkeeping) also covers drift
 * from any other source — fee-on-transfer tokens, partial fills, manual moves.
 */
async function liveSellAmount(
  position: Position,
  amountTokens: number,
): Promise<number> {
  const holder = getTradingClient().account?.address;
  if (!holder) return amountTokens;
  const balBase = await getErc20Balance(position.token as Address, holder);
  const balance = Number(formatUnits(balBase, TOKEN_DECIMALS));
  if (!Number.isFinite(balance) || balance <= 0) return amountTokens;
  // Shave a hair off so rounding in parseUnits can't land back above balance.
  return Math.min(amountTokens, balance * 0.999);
}

/** Sell `fraction` of the position's original token amount. */
export async function sell(
  config: TradeConfig,
  position: Position,
  fraction: number,
  currentPriceUsd: number,
): Promise<TradeFill> {
  const ledgerAmount = position.amountTokens * fraction;

  if (config.mode === "paper") {
    return {
      priceUsd: currentPriceUsd,
      amountTokens: ledgerAmount,
      proceedsUsd: ledgerAmount * currentPriceUsd,
    };
  }
  const amountTokens = await liveSellAmount(position, ledgerAmount);
  return runWithFallback(
    config.router,
    () => sellViaAgg(config, position, amountTokens, currentPriceUsd),
    () => sellViaHood(config, position, amountTokens, currentPriceUsd),
  );
}
