import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared embedded SQLite (node:sqlite, zero-dependency, Node ≥22). One file,
 * WAL mode: concurrent readers + serialized writers across processes, with a
 * busy_timeout so the one-shot CLIs and the monitor don't error on contention.
 * This replaces the advisory-mkdir file lock for tables that live here — ACID
 * transactions collapse the whole lost-update / TOCTOU bug class into BEGIN…
 * COMMIT (see the races cited in trade/positions.ts and lib/file-lock.ts).
 *
 * Migration is DDL-only and idempotent (CREATE … IF NOT EXISTS), gated by
 * PRAGMA user_version so it runs once. Human-readable, git-committed data
 * (case library, denylist, journal, config) deliberately stays as files — this
 * DB is only for the hot transactional / high-volume-append / query-heavy data.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Overridable (FOXHOLE_DB_PATH) so tests can use a throwaway db. */
export function dbPath(): string {
  return process.env.FOXHOLE_DB_PATH ?? path.resolve(__dirname, "../../data/foxhole.db");
}

/** Ordered schema migrations. Append only — never edit a shipped entry. */
const MIGRATIONS: string[] = [
  // v1 — decision journal (see src/trade/decisions.ts)
  `CREATE TABLE IF NOT EXISTS decisions (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     at       TEXT NOT NULL,
     verdict  TEXT NOT NULL,
     chain    TEXT NOT NULL,
     token    TEXT NOT NULL,
     symbol   TEXT,
     reason   TEXT NOT NULL,
     revisit  TEXT,
     snap_price REAL,
     snap_liq   REAL,
     snap_mcap  REAL,
     source   TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_decisions_token ON decisions(chain, token, at);
   CREATE INDEX IF NOT EXISTS idx_decisions_at ON decisions(at);`,

  // v2 — positions ledger (the money path; see src/trade/positions.ts). The
  // full Position is kept losslessly in `data` (JSON); the columns are just
  // indexed projections for openPositions / findOpen and future queries.
  `CREATE TABLE IF NOT EXISTS positions (
     id        TEXT PRIMARY KEY,
     status    TEXT NOT NULL,
     chain     TEXT NOT NULL,
     token     TEXT NOT NULL,
     mode      TEXT NOT NULL,
     opened_at TEXT NOT NULL,
     cost_usd  REAL NOT NULL,
     data      TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
   CREATE INDEX IF NOT EXISTS idx_positions_token ON positions(token);
   CREATE TABLE IF NOT EXISTS kv (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,

  // v3 — AI decision inbox (producer→decider queue; see src/notify/ai-inbox.ts).
  // archived=1 replaces the move to ai-inbox-processed.jsonl.
  `CREATE TABLE IF NOT EXISTS inbox (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     at       TEXT NOT NULL,
     kind     TEXT NOT NULL,
     archived INTEGER NOT NULL DEFAULT 0,
     data     TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_inbox_archived ON inbox(archived, at);`,

  // v4 — Hyperliquid perp ledger (see src/venues/hyperliquid/positions.ts). Same
  // JSON-blob + indexed-projection shape as spot positions; kept in its own
  // table because perp fields differ. kv 'perp:lastReportAt' holds its scalar.
  `CREATE TABLE IF NOT EXISTS perp_positions (
     id        TEXT PRIMARY KEY,
     status    TEXT NOT NULL,
     symbol    TEXT NOT NULL,
     mode      TEXT NOT NULL,
     opened_at TEXT NOT NULL,
     data      TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_perp_status ON perp_positions(status);
   CREATE INDEX IF NOT EXISTS idx_perp_symbol ON perp_positions(symbol);`,

  // v5 — review outcomes (see src/review/{ledger,movers,daily,exits-review}.ts).
  // pending/labeled/missed as tables; the two singleton states (pending-movers,
  // exit-review-state) live in kv. labeled+missed are exported back to
  // git-tracked JSON by the review auto-push so the learning audit trail
  // survives; pending + pending-movers are DB-only (transient work queues).
  `CREATE TABLE IF NOT EXISTS outcomes_pending (
     id TEXT PRIMARY KEY, chain TEXT, address TEXT, at TEXT, data TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_pending_tok ON outcomes_pending(chain, address, at);
   CREATE TABLE IF NOT EXISTS outcomes_labeled (
     id TEXT PRIMARY KEY, chain TEXT, address TEXT, at TEXT, graded_at TEXT, data TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_labeled_tok ON outcomes_labeled(chain, address, at);
   CREATE TABLE IF NOT EXISTS outcomes_missed (
     key TEXT PRIMARY KEY, chain TEXT, address TEXT, detected_at TEXT, data TEXT NOT NULL
   );`,

  // v6 — smart-money tracked-wallet book (see src/chains/robinhood/smart-money.ts).
  // Source of truth; a git-tracked data/smart-money.json mirror is still written
  // for audit. The per-wallet/chain signal filters live in kv ('smartmoney:config').
  `CREATE TABLE IF NOT EXISTS sm_wallets (
     address  TEXT PRIMARY KEY,
     chain    TEXT,
     disabled INTEGER NOT NULL DEFAULT 0,
     added_at TEXT,
     data     TEXT NOT NULL
   );`,
];

let cached: { path: string; db: DatabaseSync } | undefined;

export function getDb(): DatabaseSync {
  const p = dbPath();
  if (cached && cached.path === p) return cached.db;
  if (cached) {
    try {
      cached.db.close();
    } catch {
      // already closed
    }
  }
  mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  migrate(db);
  cached = { path: p, db };
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const current = row?.user_version ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  if (current < MIGRATIONS.length) {
    db.exec(`PRAGMA user_version=${MIGRATIONS.length}`);
  }
}

let txTail: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` inside an IMMEDIATE write transaction. Serialized in-process (the one
 * shared connection must never nest a BEGIN); cross-process writers are
 * serialized by SQLite's own write lock + busy_timeout. This is the ACID
 * replacement for the advisory mkdir file lock — same "one writer at a time,
 * see fresh state" guarantee, but atomic and fail-closed (a rare SQLITE_BUSY
 * throws and the caller retries next tick, instead of the file lock's
 * fail-open "proceed without the lock").
 */
export function transaction<T>(fn: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
  const run = txTail.then(async () => {
    const db = getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = await fn(db);
      db.exec("COMMIT");
      return r;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // transaction already rolled back / not open
      }
      throw e;
    }
  });
  txTail = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** Generic key→JSON-string store (the `kv` table) for singleton state blobs. */
export function kvGet(key: string): string | undefined {
  const row = getDb().prepare("SELECT value FROM kv WHERE key=?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}
export function kvSet(key: string, value: string): void {
  getDb()
    .prepare("INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, value);
}
export function kvDel(key: string): void {
  getDb().prepare("DELETE FROM kv WHERE key=?").run(key);
}

/** Test helper: drop the cached handle so a new FOXHOLE_DB_PATH takes effect. */
export function resetDbForTest(): void {
  if (cached) {
    try {
      cached.db.close();
    } catch {
      // ignore
    }
    cached = undefined;
  }
}
