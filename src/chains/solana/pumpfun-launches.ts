import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "../../lib/atomic-json.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * pump.fun launch watcher — the Solana analogue of the BSC four.meme pipeline
 * and the RB v4-watcher probation flow. pump.fun tokens start on a bonding
 * curve and only get a real DexScreener-indexed pool (PumpSwap / Raydium) once
 * they graduate (~$69k mcap). Freshly launched mints with early traction go on
 * a probation list; once DexScreener indexes them on Solana with liquidity ≥
 * threshold they graduate to verified tracking and get analyzed + signal-graded
 * each tick (the squeeze-radar moment), tracked for a bounded window.
 *
 * Discovery uses pump.fun's public v3 coins feed (no key). We pre-filter fresh
 * launches by market cap so the probation list stays bounded — pump.fun mints
 * thousands of dead-on-arrival tokens per hour; only ones with real early
 * traction are worth watching toward graduation.
 */

const PUMP_API_BASE =
  process.env.PUMPFUN_API_BASE ?? "https://frontend-api-v3.pump.fun";

/** Raw shape of one coin from the pump.fun v3 coins feed (subset we use). */
interface PumpCoin {
  mint: string;
  name?: string;
  symbol?: string;
  creator?: string;
  created_timestamp?: number;
  complete?: boolean;
  is_banned?: boolean;
  usd_market_cap?: number;
  market_cap_usd?: number;
}

export interface PumpLaunch {
  mint: string;
  symbol?: string;
  name?: string;
  creator?: string;
  createdAt: number;
  marketCapUsd: number;
  graduated: boolean;
}

/** Minimum USD market cap for a fresh launch to enter probation. */
export const PUMP_MIN_DISCOVERY_MCAP = Number(
  process.env.PUMP_MIN_DISCOVERY_MCAP ?? 12_000,
);
export const PUMP_TRACK_HOURS = 12;
export const PUMP_MAX_TRACKED = 40;
export const PUMP_MIN_LIQUIDITY_USD = Number(
  process.env.PUMP_MIN_LIQUIDITY_USD ?? 15_000,
);
const MAX_ATTEMPTS = 8;
/** How many launches to pull per discovery pass (feed is created-DESC). */
const DISCOVERY_LIMIT = 100;

function coinMcap(c: PumpCoin): number {
  return Number(c.usd_market_cap ?? c.market_cap_usd ?? 0);
}

/**
 * Fetch recent pump.fun launches newer than `sinceMs`, filtered to a minimum
 * market cap. Returns newest-first. Non-fatal on network error (returns []).
 */
export async function fetchRecentPumpLaunches(
  sinceMs: number,
  minMcapUsd = PUMP_MIN_DISCOVERY_MCAP,
): Promise<PumpLaunch[]> {
  const url =
    `${PUMP_API_BASE}/coins?offset=0&limit=${DISCOVERY_LIMIT}` +
    `&sort=created_timestamp&order=DESC&includeNsfw=false`;
  const res = await fetch(url, {
    headers: { "User-Agent": "foxhole-bot/0.3", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`pump.fun coins ${res.status}`);
  const coins = (await res.json()) as PumpCoin[];
  const launches: PumpLaunch[] = [];
  for (const c of coins) {
    if (!c.mint || c.is_banned) continue;
    const createdAt = Number(c.created_timestamp ?? 0);
    if (createdAt <= sinceMs) continue;
    if (coinMcap(c) < minMcapUsd) continue;
    launches.push({
      mint: c.mint,
      symbol: c.symbol,
      name: c.name,
      creator: c.creator,
      createdAt,
      marketCapUsd: coinMcap(c),
      graduated: Boolean(c.complete),
    });
  }
  return launches;
}

export function formatPumpLaunchDigest(launches: PumpLaunch[]): string {
  const sample = launches
    .slice(0, 8)
    .map((l) => l.symbol || l.name || l.mint.slice(0, 6));
  const lines = [`🐸 **pump.fun launches [SOL]**: ${launches.length} new`];
  if (sample.length) lines.push(sample.join(", "));
  return lines.join("\n");
}

const WATCH_PATH = path.resolve(__dirname, "../../../data/pumpfun-watch.json");

export interface PumpWatchEntry {
  address: string;
  symbol?: string;
  firstSeen: string;
  /** DexScreener-indexed on Solana with real liquidity → analyzed each tick. */
  verified: boolean;
  attempts: number;
  /** Best Solana 24h volume seen at last probation screen (drives near-grad pick). */
  lastVol24hUsd?: number;
}

interface PumpWatchFile {
  entries: PumpWatchEntry[];
}

export async function loadPumpWatch(): Promise<PumpWatchEntry[]> {
  try {
    return (JSON.parse(await readFile(WATCH_PATH, "utf8")) as PumpWatchFile)
      .entries;
  } catch {
    return [];
  }
}

export async function savePumpWatch(entries: PumpWatchEntry[]): Promise<void> {
  // expire; verified capped (analyzed each tick), probation capped separately
  // (cheap batch checks only) — mirrors the four.meme watcher.
  const cutoff = Date.now() - PUMP_TRACK_HOURS * 3_600_000;
  const alive = entries.filter(
    (e) =>
      new Date(e.firstSeen).getTime() > cutoff &&
      (e.verified || e.attempts < MAX_ATTEMPTS),
  );
  const verified = alive
    .filter((e) => e.verified)
    .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))
    .slice(0, PUMP_MAX_TRACKED);
  const probation = alive
    .filter((e) => !e.verified)
    .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))
    .slice(0, 400);
  await writeJsonAtomic(WATCH_PATH, { entries: [...verified, ...probation] });
}

/** Merge freshly-launched mints onto the probation list; returns # added. */
export function addPumpProbation(
  launches: PumpLaunch[],
  entries: PumpWatchEntry[],
): number {
  const seen = new Set(entries.map((e) => e.address.toLowerCase()));
  let added = 0;
  for (const l of launches) {
    if (seen.has(l.mint.toLowerCase())) continue;
    entries.push({
      address: l.mint,
      symbol: l.symbol || l.name || undefined,
      firstSeen: new Date().toISOString(),
      // Already graduated at discovery → track immediately.
      verified: l.graduated,
      attempts: 0,
    });
    seen.add(l.mint.toLowerCase());
    added++;
  }
  return added;
}

/**
 * Cheap probation screening: batch DexScreener token lookups (30 addrs per
 * request) → Solana liquidity ≥ threshold graduates to verified tracking.
 * Mirrors screenFourmemeProbation, filtered to chainId "solana".
 */
export async function screenPumpProbation(
  entries: PumpWatchEntry[],
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
          volume?: { h24?: number };
        }>;
      };
      const liqByAddr = new Map<string, number>();
      const volByAddr = new Map<string, number>();
      for (const p of data.pairs ?? []) {
        if (p.chainId !== "solana") continue;
        const a = p.baseToken?.address?.toLowerCase();
        if (!a) continue;
        liqByAddr.set(
          a,
          Math.max(liqByAddr.get(a) ?? 0, Number(p.liquidity?.usd ?? 0)),
        );
        volByAddr.set(
          a,
          Math.max(volByAddr.get(a) ?? 0, Number(p.volume?.h24 ?? 0)),
        );
      }
      for (const e of batch) {
        const key = e.address.toLowerCase();
        // Track pre-graduation trading so scanPumpWatch can pick the handful
        // worth an on-chain curve read (the graduation-imminent entry moment).
        if (volByAddr.has(key)) e.lastVol24hUsd = volByAddr.get(key);
        const liq = liqByAddr.get(key) ?? 0;
        if (liq >= PUMP_MIN_LIQUIDITY_USD) {
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

/**
 * Minimum pre-graduation 24h volume for a probation token to be worth an
 * on-chain curve read + full analysis (bounds RPC cost to the few tokens
 * actually trading toward graduation).
 */
export const PUMP_NEAR_GRAD_MIN_VOLUME_USD = Number(
  process.env.PUMP_NEAR_GRAD_MIN_VOLUME_USD ?? 20_000,
);
/** Max probation tokens analyzed for near-graduation each tick. */
export const PUMP_NEAR_GRAD_MAX_CANDIDATES = Number(
  process.env.PUMP_NEAR_GRAD_MAX_CANDIDATES ?? 6,
);

/**
 * Pick the probation (still-on-curve) tokens most worth a graduation-imminent
 * analysis: those with real pre-graduation trading, top-N by 24h volume. This
 * is what unlocks the `curve_near_grad_strong` trade trigger for Solana — the
 * on-curve window is otherwise never analyzed (analyzeTokenGeneric needs a
 * DexScreener pair, and post-graduation the curve trigger is disabled).
 */
export function nearGradCandidates(entries: PumpWatchEntry[]): PumpWatchEntry[] {
  return entries
    .filter(
      (e) => !e.verified && (e.lastVol24hUsd ?? 0) >= PUMP_NEAR_GRAD_MIN_VOLUME_USD,
    )
    .sort((a, b) => (b.lastVol24hUsd ?? 0) - (a.lastVol24hUsd ?? 0))
    .slice(0, PUMP_NEAR_GRAD_MAX_CANDIDATES);
}
