#!/usr/bin/env node
import { loadEnv } from "../lib/env.js";
loadEnv();

import { getAddress, type Address } from "viem";

import { preflightV2Buy } from "../chains/evm/v2-swap.js";
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

  const r = await preflightV2Buy(chain, token, usd, slippageBps);
  console.log(`preflight v2 buy — ${chain} ${token}`);
  console.log(`  $${usd} @ ${slippageBps}bps slippage`);
  if (r.ok) {
    console.log(`  ✅ OK — would receive ~${r.amountTokens} tokens (≈$${r.priceUsd.toExponential(4)}/token)`);
    console.log(`  quotedOut=${r.quotedOut}`);
  } else {
    console.log(`  ⛔ BLOCKED — ${r.reason}`);
  }
  process.exit(r.ok ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
