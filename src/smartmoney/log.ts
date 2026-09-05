import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { dbPath, getDb, transaction } from "../lib/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Legacy jsonl import source (pre-SQLite); overridable for tests. */
function legacyPath(): string {
  return process.env.SM_LOG_PATH ?? path.resolve(__dirname, "../../data/smart-money-log.jsonl");
}

/**
 * Append-only record of smart-money events so the review/dashboard has real
 * numbers (alerts fired, AI escalations, per token/wallet). Backed by SQLite
 * (sm_log, at-indexed) so the dashboard's 24h aggregation is a range scan, not
 * a full-file parse; the legacy jsonl is imported once.
 */
export interface SmLogEntry {
  at: string;
  kind: "alert" | "trigger" | "skipped";
  chain: string;
  wallet: string;
  walletLabel?: string;
  token: string;
  symbol?: string;
  usd?: number;
  txHash?: string;
  /** distinct tracked wallets in-window at the time (for triggers/alerts). */
  distinct?: number;
  reason?: string;
}

const backfilledPaths = new Set<string>();
function backfillInTx(db: DatabaseSync): void {
  const p = dbPath();
  if (backfilledPaths.has(p)) return;
  backfilledPaths.add(p);
  const has = (db.prepare("SELECT COUNT(*) AS n FROM sm_log").get() as { n: number }).n;
  if (has > 0) return;
  const file = legacyPath();
  if (!existsSync(file)) return;
  try {
    for (const l of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      try {
        insert(db, JSON.parse(l) as SmLogEntry);
      } catch {
        // skip a corrupt line
      }
    }
  } catch (err) {
    console.error("sm_log backfill failed:", (err as Error).message);
  }
}
async function ensureBackfilled(): Promise<void> {
  if (backfilledPaths.has(dbPath())) return;
  await transaction((db) => backfillInTx(db));
}
function insert(db: DatabaseSync, e: SmLogEntry): void {
  db.prepare("INSERT INTO sm_log (at, kind, chain, wallet, token, data) VALUES (?,?,?,?,?,?)").run(
    e.at,
    e.kind,
    e.chain,
    e.wallet,
    e.token,
    JSON.stringify(e),
  );
}

export async function appendSmLog(entry: Omit<SmLogEntry, "at">): Promise<void> {
  const line: SmLogEntry = { at: new Date().toISOString(), ...entry };
  await ensureBackfilled();
  await transaction((db) => insert(db, line));
}

export async function readSmLog(sinceMs?: number): Promise<SmLogEntry[]> {
  try {
    await ensureBackfilled();
    const db = getDb();
    const rows =
      sinceMs === undefined
        ? db.prepare("SELECT data FROM sm_log ORDER BY at").all()
        : db
            .prepare("SELECT data FROM sm_log WHERE at>=? ORDER BY at")
            .all(new Date(sinceMs).toISOString());
    return (rows as unknown as { data: string }[]).map((r) => JSON.parse(r.data) as SmLogEntry);
  } catch {
    return [];
  }
}
