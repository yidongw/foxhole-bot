#!/usr/bin/env node
import { loadEnv } from "../lib/env.js";
loadEnv();

import { getAddress, type Address } from "viem";

import { preflightV2Buy, preflightV2Sell } from "../chains/evm/v2-swap.js";
import { ALL_CHAINS, type ChainId } from "../chains/adapter.js";

/**
 * Manually preflight a v2 (PancakeSwap/Uniswap) buy without a wallet or funds:
 * quotes the route and simulates the swap on real chain state (eth_call +
 * stateOverride). Use to sanity-check a token / the live path before trading.
 *
 * Usage: foxhole preflight <bsc|base|ethereum> <token> [usdAmount] [slippageBps]
 */
async function main() {
  const [chainArg, tokenArg, usdArg, slipArg] = process.argv.slice(2);
  if (!chainArg || !tokenArg) {
    console.error(
      "Usage: foxhole preflight <bsc|base|ethereum> <token-address> [usd=50] [slippageBps=100]",
    );
    process.exit(1);
  }
  const chain = chainArg.toLowerCase() as ChainId;
  if (!(ALL_CHAINS as string[]).includes(chain)) {
    console.error(`Unknown chain "${chainArg}". v2 execution: bsc, base, ethereum`);
    process.exit(1);
  }
  let token: Address;
  try {
    token = getAddress(tokenArg);
  } catch {
    console.error(`Invalid token address: ${tokenArg}`);
    process.exit(1);
  }
  const usd = usdArg ? Number(usdArg) : 50;
  const slippageBps = slipArg ? Number(slipArg) : 100;

  console.log(`preflight round-trip — ${chain} ${token}`);
  console.log(`  $${usd} @ ${slippageBps}bps slippage`);

  const buy = await preflightV2Buy(chain, token, usd, slippageBps);
  if (!buy.ok) {
    console.log(`  BUY  ⛔ BLOCKED — ${buy.reason}`);
    process.exit(2);
  }
  const via =
    buy.path && buy.path.length > 2 ? ` via ${buy.path.length - 2} hop(s)` : " direct";
  console.log(
    `  BUY  ✅ OK${via} — ~${buy.amountTokens} tokens (≈$${buy.priceUsd.toExponential(4)}/token)`,
  );

  const sell = await preflightV2Sell(chain, token, buy.amountTokens, slippageBps);
  if (sell.ok && sell.simulated) {
    console.log(`  SELL ✅ OK — token is sellable (not a honeypot)`);
  } else if (sell.ok && !sell.simulated) {
    console.log(`  SELL ⚠️  ${sell.reason}`);
  } else {
    console.log(`  SELL ⛔ BLOCKED — ${sell.reason}`);
  }
  process.exit(sell.ok ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
