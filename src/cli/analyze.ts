#!/usr/bin/env node
import { loadEnv } from "../lib/env.js";
loadEnv();

import { ALL_CHAINS, type ChainId } from "../chains/adapter.js";
import { getAdapter } from "../chains/registry.js";
import { formatAnalysisReport } from "../long/analyze-token.js";

/**
 * Manual token analysis for any supported chain (parity with the monitor's
 * per-chain adapters). Robinhood stays the default so existing invocations —
 * `foxhole analyze <addr>` — are unchanged; add `--chain bsc` for BNB Chain,
 * `--chain solana`, etc.
 */
function parseArgs(argv: string[]): { chain: ChainId; address?: string } {
  let chain: ChainId = "robinhood";
  let address: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--chain" || arg === "-c") {
      chain = argv[++i] as ChainId;
    } else if (arg.startsWith("--chain=")) {
      chain = arg.slice("--chain=".length) as ChainId;
    } else if (!arg.startsWith("-")) {
      address = arg;
    }
  }
  return { chain, address };
}

async function main() {
  const { chain, address } = parseArgs(process.argv.slice(2));
  if (!address) {
    console.error(
      "Usage: foxhole analyze [--chain <robinhood|solana|bsc|base|ethereum>] <token-address>",
    );
    process.exit(1);
  }
  if (!ALL_CHAINS.includes(chain)) {
    console.error(`Unknown chain "${chain}". Supported: ${ALL_CHAINS.join(", ")}`);
    process.exit(1);
  }
  const analysis = await getAdapter(chain).analyze(address);
  console.log(formatAnalysisReport(analysis));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
