import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { dbPath, getDb, transaction } from "../lib/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Legacy JSON import source (pre-SQLite); overridable for tests. */
function legacyPath(): string {
  return process.env.DENYLIST_PATH ?? path.resolve(__dirname, "../../data/review-denylist.json");
}

/**
 * Human-judgment denylist: tokens the user marked as garbage during review
 * confirmation. Permanent — filtered from mover lists, tuner cases, and
 * vetoed at the entry gate. This is how manual review feedback compounds.
 * Stored in SQLite (review_denylist, audited — removals/edits keep history); a
 * legacy JSON is imported once.
 */

export interface DenyEntry {
  chain: string;
  address: string;
  symbol?: string;
  reason: string;
  addedAt: string;
}

const keyOf = (chain: string, address: string) => `${chain.toLowerCase()}:${address.toLowerCase()}`;

const backfilledPaths = new Set<string>();
function backfillInTx(db: DatabaseSync): void {
  const p = dbPath();
  if (backfilledPaths.has(p)) return;
  backfilledPaths.add(p);
  const has = (db.prepare("SELECT COUNT(*) AS n FROM review_denylist").get() as { n: number }).n;
  if (has > 0) return;
  const file = legacyPath();
  if (!existsSync(file)) return;
  try {
    for (const e of JSON.parse(readFileSync(file, "utf8")) as DenyEntry[]) insert(db, e);
  } catch (err) {
    console.error("denylist backfill failed:", (err as Error).message);
  }
}
async function ensureBackfilled(): Promise<void> {
  if (backfilledPaths.has(dbPath())) return;
  await transaction((db) => backfillInTx(db));
}
function insert(db: DatabaseSync, e: DenyEntry): void {
  db.prepare(
    `INSERT INTO review_denylist (key, chain, address, added_at, data) VALUES (?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET chain=excluded.chain, address=excluded.address,
       added_at=excluded.added_at, data=excluded.data`,
  ).run(keyOf(e.chain, e.address), e.chain.toLowerCase(), e.address.toLowerCase(), e.addedAt, JSON.stringify(e));
}

export async function loadDenylist(): Promise<DenyEntry[]> {
  try {
    await ensureBackfilled();
    return (getDb().prepare("SELECT data FROM review_denylist ORDER BY added_at").all() as unknown as {
      data: string;
    }[]).map((r) => JSON.parse(r.data) as DenyEntry);
  } catch {
    return [];
  }
}

export async function addToDenylist(entries: Omit<DenyEntry, "addedAt">[]): Promise<void> {
  // Dedup + insert in one write transaction — the ACID replacement for the
  // withFileLock that stopped concurrent review loops rolling back each other's
  // entries (pussy/BEARER 2026-09-04).
  await ensureBackfilled();
  await transaction((db) => {
    for (const e of entries) {
      const key = keyOf(e.chain, e.address);
      const dup = db.prepare("SELECT 1 FROM review_denylist WHERE key=? LIMIT 1").get(key);
      if (dup) continue;
      insert(db, { ...e, addedAt: new Date().toISOString() });
    }
  });
}

export async function removeFromDenylist(chain: string, address: string): Promise<boolean> {
  await ensureBackfilled();
  return transaction((db) => {
    const r = db.prepare("DELETE FROM review_denylist WHERE key=?").run(keyOf(chain, address));
    return r.changes > 0; // DELETE → history keeps the removed entry
  });
}

export async function isDenylisted(chain: string, address: string): Promise<boolean> {
  try {
    await ensureBackfilled();
    const row = getDb()
      .prepare("SELECT 1 FROM review_denylist WHERE key=? LIMIT 1")
      .get(keyOf(chain, address));
    return !!row;
  } catch {
    return false;
  }
}
