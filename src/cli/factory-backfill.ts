#!/usr/bin/env node
import { loadEnv } from "../lib/env.js";
loadEnv();

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  fetchCreatedEvents,
  getLatestBlock,
} from "../long/factory-watcher.js";
import { getPublicClient } from "../chain/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, "../../data/factory-launches.json");

/** Binary-search the first block at/after the given unix timestamp. */
async function blockAtTimestamp(target: number): Promise<bigint> {
  const client = getPublicClient();
  let lo = 0n;
  let hi = await client.getBlockNumber();
  while (hi - lo > 2000n) {
    const mid = (lo + hi) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (Number(block.timestamp) < target) lo = mid;
    else hi = mid;
  }
  return lo;
}

async function main() {
  const daysArg = process.argv.find((a) => a.startsWith("--days="));
  const days = daysArg ? Number(daysArg.split("=")[1]) : 30;

  console.log(`Backfilling Long.xyz factory launches for the last ${days} days…`);
  const startTs = Math.floor(Date.now() / 1000) - days * 86_400;
  const fromBlock = await blockAtTimestamp(startTs);
  const toBlock = await getLatestBlock();
  console.log(`Block range: ${fromBlock} → ${toBlock}`);

  const launches = await fetchCreatedEvents({
    fromBlock,
    toBlock,
    chunkSize: 50_000n,
    chunkDelayMs: 600,
  });
  console.log(`Found ${launches.length} launches`);

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(
    OUT_PATH,
    JSON.stringify(
      {
        meta: {
          fetched_at: new Date().toISOString(),
          from_block: fromBlock.toString(),
          to_block: toBlock.toString(),
          days,
          count: launches.length,
        },
        launches: launches.map((l) => ({
          ...l,
          blockNumber: l.blockNumber.toString(),
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`wrote ${OUT_PATH}`);

  for (const l of launches.slice(-10)) {
    console.log(
      `  ${l.epochStart} ${l.symbol}/${l.pairSymbol ?? l.pairToken.slice(0, 10)} ${l.token}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
