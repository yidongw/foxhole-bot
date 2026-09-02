import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchDexJson } from "../dex/dexscreener.js";
import { sleep } from "../lib/utils.js";
import type { MonitorState } from "../monitor/state.js";
import type { DexPair } from "../types.js";
import type { AlertRecord, LabeledOutcome } from "./ledger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MISSED_PATH = path.resolve(__dirname, "../../data/outcomes/missed.json");

/** A pump has to at least double to count as 暴涨. */
export const MOVER_MIN_CHANGE_PCT = 100;
/** Above this the pool is almost certainly broken data. */
export const MOVER_MAX_CHANGE_PCT = 10_000;
export const MOVER_MIN_LIQUIDITY_USD = 30_000;
export const MOVER_MIN_VOLUME_USD = 100_000;

const EXCLUDED_SYMBOLS = new Set([
  "WETH", "ETH", "WBNB", "BNB", "SOL", "WSOL", "USDT", "USDC", "USDG",
  "DAI", "WBTC", "BTCB", "CAKE", "UNI",
]);

interface PaprikaPool {
  id: string;
  volume_usd_24h?: number;
  price_change_percentage_24h?: number;
  liquidity_usd?: number;
}

export interface Mover {
  chain: string;
  poolId: string;
  address: string;
  symbol?: string;
  priceChange24h: number;
  volume24hUsd: number;
  liquidityUsd: number;
}

export type MissKind = "alerted" | "threshold_miss" | "coverage_miss";

export interface ClassifiedMover extends Mover {
  kind: MissKind;
}

export interface MissedCase extends ClassifiedMover {
  detectedAt: string;
}

/**
 * Top 暴涨 tokens on a chain in the last 24h. Volume-sorted (price-change
 * sorting on DexPaprika surfaces broken pools), then filtered, then the
 * base token resolved via DexScreener.
 */
export async function fetchTopMovers(chain: string, limit = 8): Promise<Mover[]> {
  const res = await fetch(
    `https://api.dexpaprika.com/networks/${chain}/pools/search?limit=100&order_by=volume_usd_24h&sort=desc`,
    { headers: { "User-Agent": "foxhole-bot/0.3" } },
  );
  if (!res.ok) throw new Error(`DexPaprika movers ${res.status} for ${chain}`);
  const data = (await res.json()) as { results?: PaprikaPool[] };

  const candidates = (data.results ?? []).filter((p) => {
    const chg = p.price_change_percentage_24h ?? 0;
    return (
      chg >= MOVER_MIN_CHANGE_PCT &&
      chg <= MOVER_MAX_CHANGE_PCT &&
      (p.liquidity_usd ?? 0) >= MOVER_MIN_LIQUIDITY_USD &&
      (p.volume_usd_24h ?? 0) >= MOVER_MIN_VOLUME_USD
    );
  });

  const movers: Mover[] = [];
  for (const pool of candidates.slice(0, limit * 2)) {
    if (movers.length >= limit) break;
    try {
      const pair = await fetchDexJson<{ pairs?: DexPair[] }>(
        `/latest/dex/pairs/${chain}/${pool.id}`,
      );
      const p = pair.pairs?.[0];
      const symbol = p?.baseToken?.symbol;
      const address = p?.baseToken?.address;
      if (!address || (symbol && EXCLUDED_SYMBOLS.has(symbol.toUpperCase()))) {
        continue;
      }
      movers.push({
        chain,
        poolId: pool.id,
        address,
        symbol,
        priceChange24h: pool.price_change_percentage_24h ?? 0,
        volume24hUsd: pool.volume_usd_24h ?? 0,
        liquidityUsd: pool.liquidity_usd ?? 0,
      });
    } catch {
      // pair not on DexScreener — skip
    }
    await sleep(200);
  }
  return movers;
}

/** Mover token addresses as an extra discovery feed for the regular scan. */
export async function fetchMoverCandidates(chain: string): Promise<string[]> {
  try {
    return (await fetchTopMovers(chain, 10)).map((m) => m.address);
  } catch (err) {
    console.error(`${chain} movers feed failed:`, (err as Error).message);
    return [];
  }
}

/** Pure classification — exported for tests. */
export function classifyMover(
  mover: Mover,
  state: MonitorState,
  ledger: Array<Pick<AlertRecord, "chain" | "address" | "at">>,
  now: number = Date.now(),
): MissKind {
  const key = `${mover.chain}:${mover.address.toLowerCase()}`;
  const windowMs = 36 * 60 * 60 * 1000;
  const alerted = ledger.some(
    (r) =>
      `${r.chain}:${r.address.toLowerCase()}` === key &&
      now - new Date(r.at).getTime() < windowMs,
  );
  if (alerted) return "alerted";

  const stateKey =
    mover.chain === "robinhood"
      ? mover.address.toLowerCase()
      : `${mover.chain}:${mover.address.toLowerCase()}`;
  return state.tokens[stateKey] ? "threshold_miss" : "coverage_miss";
}

export async function loadMissedCases(): Promise<MissedCase[]> {
  try {
    return JSON.parse(await readFile(MISSED_PATH, "utf8")) as MissedCase[];
  } catch {
    return [];
  }
}

export async function saveMissedCases(
  fresh: ClassifiedMover[],
): Promise<MissedCase[]> {
  const existing = await loadMissedCases();
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set(
    existing.map((m) => `${m.chain}:${m.address.toLowerCase()}:${m.detectedAt.slice(0, 10)}`),
  );
  const added: MissedCase[] = [];
  for (const m of fresh) {
    if (m.kind === "alerted") continue;
    const key = `${m.chain}:${m.address.toLowerCase()}:${today}`;
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({ ...m, detectedAt: new Date().toISOString() });
  }
  if (added.length) {
    await mkdir(path.dirname(MISSED_PATH), { recursive: true });
    await writeFile(
      MISSED_PATH,
      JSON.stringify([...existing, ...added], null, 2),
      "utf8",
    );
  }
  return added;
}

/** Full daily mover sweep across chains: classify + persist misses. */
export async function scanMissedMovers(
  chains: string[],
  state: MonitorState,
  ledger: Array<Pick<AlertRecord, "chain" | "address" | "at">>,
): Promise<ClassifiedMover[]> {
  const classified: ClassifiedMover[] = [];
  for (const chain of chains) {
    try {
      const movers = await fetchTopMovers(chain);
      for (const m of movers) {
        classified.push({ ...m, kind: classifyMover(m, state, ledger) });
      }
    } catch (err) {
      console.error(`${chain} mover scan failed:`, (err as Error).message);
    }
    await sleep(300);
  }
  await saveMissedCases(classified);
  return classified;
}

export type { LabeledOutcome };
