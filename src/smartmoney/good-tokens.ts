import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { dbPath, getDb, transaction } from "../lib/db.js";

/**
 * Local record of "good tokens" — the tokens WE consider validated (reached a
 * real peak mcap, not a rug). This is the source universe the winner-finder
 * mines for wallets worth tracking. Maintained by hand (CLI) and, later,
 * auto-appended by the review when a token's peak mcap clears the bar.
 * Stored in SQLite (sm_good_tokens, audited); a legacy JSON is imported once.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Legacy JSON import source (pre-SQLite); overridable for tests. */
function legacyPath(): string {
  return process.env.GOOD_TOKENS_PATH ?? path.resolve(__dirname, "../../data/good-tokens.json");
}

export interface GoodToken {
  chain: string;
  address: string;
  symbol?: string;
  peakMcap?: number;
  addedAt: string;
  addedBy?: string;
}

interface GoodTokenFile {
  tokens: GoodToken[];
}

const keyOf = (chain: string, address: string) => `${chain.toLowerCase()}:${address.toLowerCase()}`;

const backfilledPaths = new Set<string>();
function backfillInTx(db: DatabaseSync): void {
  const p = dbPath();
  if (backfilledPaths.has(p)) return;
  backfilledPaths.add(p);
  const has = (db.prepare("SELECT COUNT(*) AS n FROM sm_good_tokens").get() as { n: number }).n;
  if (has > 0) return;
  const file = legacyPath();
  if (!existsSync(file)) return;
  try {
    const { tokens } = JSON.parse(readFileSync(file, "utf8")) as GoodTokenFile;
    for (const t of tokens ?? []) upsert(db, t);
  } catch (err) {
    console.error("good-tokens backfill failed:", (err as Error).message);
  }
}
async function ensureBackfilled(): Promise<void> {
  if (backfilledPaths.has(dbPath())) return;
  await transaction((db) => backfillInTx(db));
}
function upsert(db: DatabaseSync, t: GoodToken): void {
  db.prepare(
    `INSERT INTO sm_good_tokens (key, chain, address, added_at, data) VALUES (?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET chain=excluded.chain, address=excluded.address,
       added_at=excluded.added_at, data=excluded.data`,
  ).run(keyOf(t.chain, t.address), t.chain.toLowerCase(), t.address.toLowerCase(), t.addedAt, JSON.stringify(t));
}

export async function loadGoodTokens(): Promise<GoodToken[]> {
  try {
    await ensureBackfilled();
    return (getDb().prepare("SELECT data FROM sm_good_tokens ORDER BY added_at").all() as unknown as {
      data: string;
    }[]).map((r) => JSON.parse(r.data) as GoodToken);
  } catch {
    return [];
  }
}

/** Bulk save (diff): upsert present, delete removed — audit-clean. */
export async function saveGoodTokens(tokens: GoodToken[]): Promise<void> {
  await ensureBackfilled();
  await transaction((db) => {
    const keep = new Set(tokens.map((t) => keyOf(t.chain, t.address)));
    const current = (db.prepare("SELECT key FROM sm_good_tokens").all() as unknown as {
      key: string;
    }[]).map((r) => r.key);
    const del = db.prepare("DELETE FROM sm_good_tokens WHERE key=?");
    for (const k of current) if (!keep.has(k)) del.run(k);
    for (const t of tokens) upsert(db, t);
  });
}

export async function addGoodToken(
  t: Omit<GoodToken, "addedAt">,
): Promise<{ added: boolean; tokens: GoodToken[] }> {
  await ensureBackfilled();
  const added = await transaction((db) => {
    const exists = db.prepare("SELECT 1 FROM sm_good_tokens WHERE key=? LIMIT 1").get(keyOf(t.chain, t.address));
    if (exists) return false;
    upsert(db, { ...t, addedAt: new Date().toISOString() });
    return true;
  });
  return { added, tokens: await loadGoodTokens() };
}

export async function goodTokensForChain(chain: string): Promise<GoodToken[]> {
  const c = chain.toLowerCase();
  return (await loadGoodTokens()).filter((t) => t.chain.toLowerCase() === c);
}
