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
