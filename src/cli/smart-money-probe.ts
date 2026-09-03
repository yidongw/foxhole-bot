#!/usr/bin/env node
import { loadEnv } from "../lib/env.js";
loadEnv();

import { getAddress, type Address } from "viem";
import { getErc20Symbol, getLogsClient } from "../chain/client.js";
import { fetchLogsChunked } from "../chains/evm/log-watcher.js";
import {
  RB_V4_POOL_MANAGER,
  TRANSFER_TOPIC0,
  V4_INITIALIZE_TOPIC0,
  V4_SWAP_TOPIC0,
  addressTopic,
  decodeInitializePair,
  decodeSwap,
  decodeTransfer,
  detectBuys,
  type PoolPair,
  type SwapHit,
  type TransferHit,
} from "../chains/robinhood/smart-money.js";

/**
 * One-shot probe: scan the last N blocks for a wallet's on-chain buys, using
 * the same detection path as the live watcher. Reports connectivity, raw
 * activity counts, and any confirmed buys.
 *
 *   tsx src/cli/smart-money-probe.ts <address> [lookbackBlocks]
 */
async function main() {
  const wallet = getAddress(process.argv[2]);
  const lookback = BigInt(process.argv[3] ?? "150000"); // ~4h at ~100ms blocks
  const client = getLogsClient();

  const latest = await client.getBlockNumber();
  const from = latest > lookback ? latest - lookback : 0n;
  console.log(
    `RPC ok. latest block ${latest}. scanning ${from}..${latest} (${lookback} blocks) for ${wallet}`,
  );

  const [transferLogs, swapLogs] = await Promise.all([
    fetchLogsChunked(client, {
      topics: [TRANSFER_TOPIC0, null, [addressTopic(wallet)]],
      fromBlock: from,
      toBlock: latest,
      chunkSize: 5_000n,
    }),
    fetchLogsChunked(client, {
      address: RB_V4_POOL_MANAGER,
      topics: [V4_SWAP_TOPIC0],
      fromBlock: from,
      toBlock: latest,
      chunkSize: 5_000n,
    }),
  ]);

  const transfers = transferLogs
    .map(decodeTransfer)
    .filter((t): t is TransferHit => !!t);
  const swaps = swapLogs.map(decodeSwap).filter((s): s is SwapHit => !!s);
  console.log(
    `raw: ${transfers.length} transfers to wallet, ${swaps.length} v4 swaps in range`,
  );

  // Resolve pools only for swaps sharing a tx with a wallet transfer.
  const txs = new Set(transfers.map((t) => t.txHash));
  const relevant = swaps.filter((s) => txs.has(s.txHash));
  console.log(`swaps in the wallet's own txs: ${relevant.length}`);

  const pairMap = new Map<string, PoolPair>();
  for (const s of relevant) {
    if (pairMap.has(s.poolId)) continue;
    const logs = (await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: RB_V4_POOL_MANAGER,
          topics: [V4_INITIALIZE_TOPIC0, s.poolId as `0x${string}`],
          fromBlock: "0x0",
          toBlock: "latest",
        },
      ],
    })) as Array<{ address: Address; topics: `0x${string}`[]; data: `0x${string}` }>;
    for (const raw of logs) {
      const p = decodeInitializePair({
        address: raw.address,
        topics: raw.topics,
        data: raw.data,
        blockNumber: 0n,
        transactionHash: "0x",
      });
      if (p) pairMap.set(p.poolId, { currency0: p.currency0, currency1: p.currency1 });
    }
  }

  const buys = detectBuys(
    transfers,
    relevant,
    pairMap,
    new Set([wallet.toLowerCase()]),
  );
  if (!buys.length) {
    console.log("→ no confirmed buys in this window.");
    return;
  }
  console.log(`\n→ ${buys.length} confirmed buy(s):`);
  for (const b of buys) {
    const symbol = (await getErc20Symbol(b.token as Address)) ?? "?";
    console.log(
      `  $${symbol}  ${b.quoteAmount.toFixed(4)} ${b.quoteSymbol}  token=${b.token}  tx=${b.txHash}`,
    );
  }
}

main().catch((err) => {
  console.error("probe failed:", (err as Error).message);
  process.exit(1);
});
