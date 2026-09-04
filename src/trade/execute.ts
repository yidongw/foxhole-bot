import { formatUnits, parseUnits, type Address } from "viem";
import { executeSwap, MAINNET_ADDRESSES, parseUsdg } from "hoodchain";

import { getTradingClient } from "../chain/client.js";
import { okxSwap } from "../venues/okx/swap.js";
import type { TradeConfig } from "./config.js";
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
 * Buy `usd` worth of `token`.
 * Paper mode fills at the observed DexScreener price with zero slippage —
 * optimistic by design; live results will be worse.
 *
 * Live mode routes USDG → token through hoodchain's v3 router. Long.xyz
 * pools are Uniswap v4, so a NoRouteError here means the token has no v3
 * route yet — surfaced to the caller, never swallowed.
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

  if (config.router === "okx") {
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

  if (config.router === "okx") {
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
  const proceedsUsd = Number(formatUnits(quote.amountOut, 6)); // USDG = 6 decimals
  return {
    priceUsd: amountTokens > 0 ? proceedsUsd / amountTokens : currentPriceUsd,
    amountTokens,
    proceedsUsd,
    txHash: hash,
  };
}
