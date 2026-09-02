#!/usr/bin/env node
/**
 * One-shot historical lock ratio sample via archive RPC.
 * Usage: npm run sample-lock -- BONER 2026-08-28T12:00:00Z
 */
import { getAddress, type Hex } from "viem";
import { PUMP_FIXTURES } from "../backtest/fixtures.js";
import { fetchPoolMeta } from "../dex/dexpaprika.js";
import {
  estimateBlockForTime,
  sampleQuoteLockAtBlock,
  supportsArchiveRpc,
} from "../chain/historical-lock.js";

async function main() {
  const [symbol, isoTime] = process.argv.slice(2);
  if (!symbol || !isoTime) {
    console.error("Usage: npm run sample-lock -- <SYMBOL> <ISO_TIME>");
    console.error("Example: npm run sample-lock -- BONER 2026-08-28T12:00:00Z");
    process.exit(1);
  }

  if (!supportsArchiveRpc()) {
    console.error(
      "Archive RPC required. Set ROBINHOOD_RPC to Alchemy/Infura/QuickNode in .env",
    );
    process.exit(1);
  }

  const fixture = PUMP_FIXTURES.find(
    (f) => f.symbol.toLowerCase() === symbol.toLowerCase(),
  );
  if (!fixture) {
    console.error(`Unknown symbol: ${symbol}`);
    process.exit(1);
  }

  const poolMeta = await fetchPoolMeta(fixture.poolId);
  const quoteToken = getAddress(poolMeta.quote_token_id);
  const targetMs = new Date(isoTime).getTime();
  const block = estimateBlockForTime(
    {
      createdAtBlock: poolMeta.created_at_block_number,
      createdAtMs: new Date(poolMeta.created_at).getTime(),
    },
    targetMs,
  );

  console.log(`Sampling ${fixture.symbol} lock at ${isoTime} (est. block ${block})…`);
  const sample = await sampleQuoteLockAtBlock(
    fixture.poolId as Hex,
    quoteToken,
    false,
    block,
  );

  if (!sample) {
    console.error("Failed — RPC may not support historical eth_call at this block.");
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        symbol: fixture.symbol,
        at: isoTime,
        block: sample.blockNumber.toString(),
        quoteLockRatio: sample.quoteLockRatio,
        quoteLockPct: `${(sample.quoteLockRatio * 100).toFixed(2)}%`,
        quoteLocked: sample.quoteLocked.toString(),
        quoteTotalSupply: sample.quoteTotalSupply.toString(),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
