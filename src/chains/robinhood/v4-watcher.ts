import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, type Address } from "viem";

import { getLogsClient } from "../../chain/client.js";
import { fetchLogsChunked } from "../evm/log-watcher.js";
import { writeJsonAtomic } from "../../lib/atomic-json.js";

/**
 * RB 链 Uniswap v4 通用新池 watcher — the JINQIAN lesson made structural.
 *
 * The Long factory watcher only sees Long.xyz launches; pure RB memes
 * (JINQIAN/FAMI, +700% on $92M volume) initialize pools directly on the
 * v4 PoolManager and were invisible to every discovery source until after
 * the pump. This watcher sees EVERY new v4 pool at creation.
 *
 * Volume control: new tokens go to a probation list; once DexScreener
 * indexes them with liquidity ≥ $30K they're tracked (每 tick 分析) for
 * 12h, capped at 40 tokens by recency.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCH_PATH = path.resolve(__dirname, "../../../data/v4-watch.json");

/** Verified live 2026-09-02 via the JINQIAN pool's Initialize log. */
export const RB_V4_POOL_MANAGER =
  "0x8366a39cc670b4001a1121b8f6a443a643e40951" as const;
export const V4_INITIALIZE_TOPIC0 =
  "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438" as const;

/** Quote-side currencies that are never meme candidates. */
const KNOWN_QUOTES = new Set(
  [
    "0x0000000000000000000000000000000000000000", // native
    "0x0bd7d308f8e1639fab988df18a8011f41eacad73", // WETH (RB)
    "0x5fc5360d0400a0fd4f2af552add042d716f1d168", // USDG
    "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544", // Long auction numeraire
  ].map((a) => a.toLowerCase()),
);

export interface V4WatchEntry {
  address: string;
  firstSeen: string;
  /** DexScreener-indexed with real liquidity → actively analyzed each tick. */
  verified: boolean;
  attempts: number;
}

interface V4WatchFile {
  entries: V4WatchEntry[];
}

export const V4_TRACK_HOURS = 12;
export const V4_MAX_TRACKED = 40;
export const V4_MIN_LIQUIDITY_USD = 30_000;
const MAX_ATTEMPTS = 5;

export async function loadV4Watch(): Promise<V4WatchEntry[]> {
  try {
    return (JSON.parse(await readFile(WATCH_PATH, "utf8")) as V4WatchFile).entries;
  } catch {
    return [];
  }
}

export async function saveV4Watch(entries: V4WatchEntry[]): Promise<void> {
  // expire; verified capped at V4_MAX_TRACKED (deep-analyzed each tick),
  // probation capped separately (cheap batch checks only)
  const cutoff = Date.now() - V4_TRACK_HOURS * 3_600_000;
  const alive = entries.filter(
    (e) =>
      new Date(e.firstSeen).getTime() > cutoff &&
      (e.verified || e.attempts < MAX_ATTEMPTS),
  );
  const verified = alive
    .filter((e) => e.verified)
    .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))
    .slice(0, V4_MAX_TRACKED);
  const probation = alive
    .filter((e) => !e.verified)
    .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))
    .slice(0, 300);
  await writeJsonAtomic(WATCH_PATH, { entries: [...verified, ...probation] });
}

/**
 * Cheap probation screening: batch DexScreener token lookups (30 addrs per
 * request) → liquidity ≥ threshold graduates to verified tracking.
 */
export async function screenProbation(
  entries: V4WatchEntry[],
  batchLimit = 5,
): Promise<number> {
  const probation = entries.filter((e) => !e.verified);
  let promoted = 0;
  for (let i = 0; i < probation.length && i / 30 < batchLimit; i += 30) {
    const batch = probation.slice(i, i + 30);
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${batch.map((e) => e.address).join(",")}`,
        { headers: { "User-Agent": "foxhole-bot/0.3" } },
      );
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        pairs?: Array<{
          chainId: string;
          baseToken?: { address?: string };
          liquidity?: { usd?: number };
        }>;
      };
      const liqByAddr = new Map<string, number>();
      for (const p of data.pairs ?? []) {
        if (p.chainId !== "robinhood") continue;
        const a = p.baseToken?.address?.toLowerCase();
        if (!a) continue;
        liqByAddr.set(a, Math.max(liqByAddr.get(a) ?? 0, Number(p.liquidity?.usd ?? 0)));
      }
      for (const e of batch) {
        const liq = liqByAddr.get(e.address.toLowerCase()) ?? 0;
        if (liq >= V4_MIN_LIQUIDITY_USD) {
          e.verified = true;
          promoted++;
        } else {
          e.attempts++;
        }
      }
    } catch {
      // batch failed — retry next tick without burning attempts
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return promoted;
}

/** Scan PoolManager Initialize events; returns new candidate token addrs. */
export async function fetchNewV4PoolTokens(
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Address[]> {
  const logs = await fetchLogsChunked(getLogsClient(), {
    address: RB_V4_POOL_MANAGER,
    topics: [V4_INITIALIZE_TOPIC0],
    fromBlock,
    toBlock,
    chunkSize: 10_000n,
    chunkDelayMs: 400,
  });
  const out = new Set<Address>();
  for (const log of logs) {
    for (const topic of [log.topics[2], log.topics[3]]) {
      if (!topic) continue;
      const addr = getAddress(`0x${topic.slice(26)}`);
      const lower = addr.toLowerCase();
      if (KNOWN_QUOTES.has(lower)) continue;
      // Long.xyz memes carry a 1e18 vanity suffix and are already covered
      // by the factory watcher + launches scan — this watcher exists for
      // everything else (~600 Long inits per 50min would drown probation).
      if (lower.endsWith("1e18")) continue;
      out.add(addr);
    }
  }
  return [...out];
}

export async function getV4LatestBlock(): Promise<bigint> {
  return getLogsClient().getBlockNumber();
}
