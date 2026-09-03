import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "../../lib/atomic-json.js";
import { fetchStockAssets, type StockAsset } from "./stock-registry.js";

/**
 * Registry-diff watcher — the earliest ON-CHAIN footprint of the "real"
 * tokenized-stock squeeze play (mmk_btc thread): the play can't happen until
 * the target stock is minted as an official Robinhood stock token, i.e. it
 * appears in the registry. A brand-new symbol showing up here leads the meme
 * pool that pairs against it. Noise is tiny (a few new listings a day at most).
 *
 * The first run SEEDS the snapshot silently — the ~194 pre-existing stocks are
 * not "new", so they carry seeded:true and never trigger the newly-listed
 * badge. Only symbols that appear in later diffs are genuinely new.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.resolve(__dirname, "../../../data/rh-stock-registry.json");
const NEWLY_LISTED_DAYS = 7;

interface StockEntry {
  name?: string;
  address?: string;
  firstSeenAt: string;
  /** true = present at bootstrap, so never treated as newly-listed. */
  seeded: boolean;
}

interface Snapshot {
  seededAt?: string;
  symbols: Record<string, StockEntry>;
}

export interface StockDiff {
  /** Genuinely new listings (empty on the seeding run). */
  newStocks: StockAsset[];
  /** true when this run seeded an empty snapshot — callers must not alert. */
  bootstrap: boolean;
}

/** Pure diff core — assets not already known. Exported for tests. */
export function pickNewStocks(
  assets: StockAsset[],
  known: Set<string>,
): StockAsset[] {
  return assets.filter((a) => !known.has(a.symbol));
}

/** Pure freshness check — exported for tests. */
export function freshFromEntry(
  entry: { firstSeenAt: string; seeded: boolean; name?: string } | undefined,
  nowMs: number,
  withinDays: number,
): NewlyListed | undefined {
  if (!entry || entry.seeded) return undefined;
  const ageDays = (nowMs - new Date(entry.firstSeenAt).getTime()) / 86_400_000;
  if (ageDays < 0 || ageDays > withinDays) return undefined;
  return { name: entry.name, firstSeenAt: entry.firstSeenAt, ageDays };
}

async function loadSnapshot(): Promise<Snapshot | undefined> {
  try {
    return JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")) as Snapshot;
  } catch {
    return undefined;
  }
}

/**
 * Fetch the registry, diff against the persisted snapshot, persist the merged
 * snapshot. Returns new listings to alert on. Returns no new stocks (and does
 * not throw) when the registry is unreachable — nothing to diff against.
 */
export async function diffStockRegistry(): Promise<StockDiff> {
  const assets = await fetchStockAssets();
  if (!assets) return { newStocks: [], bootstrap: false };

  const now = new Date().toISOString();
  const prior = await loadSnapshot();

  if (!prior) {
    // Seed silently: every current stock is pre-existing, not new.
    const symbols: Record<string, StockEntry> = {};
    for (const a of assets) {
      symbols[a.symbol] = {
        name: a.name,
        address: a.address,
        firstSeenAt: now,
        seeded: true,
      };
    }
    await writeJsonAtomic(SNAPSHOT_PATH, { seededAt: now, symbols });
    return { newStocks: [], bootstrap: true };
  }

  const symbols = { ...prior.symbols };
  const newStocks = pickNewStocks(assets, new Set(Object.keys(prior.symbols)));
  for (const a of newStocks) {
    symbols[a.symbol] = {
      name: a.name,
      address: a.address,
      firstSeenAt: now,
      seeded: false,
    };
  }
  if (newStocks.length) {
    await writeJsonAtomic(SNAPSHOT_PATH, { seededAt: prior.seededAt, symbols });
  }
  return { newStocks, bootstrap: false };
}

export interface NewlyListed {
  name?: string;
  firstSeenAt: string;
  ageDays: number;
}

/**
 * For the ② trade-signal badge: is this quote stock a recently-added official
 * listing? Seeded (bootstrap) stocks never qualify. Returns undefined for
 * unknown / old / seeded symbols.
 */
export async function newlyListedQuote(
  symbol: string | undefined,
  withinDays = NEWLY_LISTED_DAYS,
): Promise<NewlyListed | undefined> {
  if (!symbol) return undefined;
  const snap = await loadSnapshot();
  return freshFromEntry(snap?.symbols[symbol.toUpperCase()], Date.now(), withinDays);
}
