import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dbPath, getDb } from "../lib/db.js";

/**
 * Unified journal store (SQLite `journal` table): the review log, per-day filter
 * logs, and per-day trade logs — all append-only markdown, never read back by
 * code, now rows instead of git-tracked files (personal data out of the public
 * repo). On first use the pre-existing markdown files are imported once.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
export type JournalKind = "review" | "filter" | "trade";

const seeded = new Set<string>();
function ensureBackfill(): void {
  const p = dbPath();
  if (seeded.has(p)) return;
  seeded.add(p);
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM journal").get() as { n: number }).n;
    if (n === 0) {
      const ins = db.prepare("INSERT INTO journal (at, kind, text) VALUES (?,?,?)");
      const importFile = (file: string, kind: JournalKind, at: string) => {
        if (!existsSync(file)) return;
        try {
          ins.run(at, kind, readFileSync(file, "utf8"));
        } catch {
          // skip unreadable file
        }
      };
      importFile(path.join(ROOT, "REVIEW-LOG.md"), "review", new Date().toISOString());
      const importDir = (dir: string, kind: JournalKind) => {
        try {
          for (const f of readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
            importFile(path.join(dir, f), kind, `${f.slice(0, 10)}T00:00:00.000Z`);
          }
        } catch {
          // dir absent — nothing to import
        }
      };
      importDir(path.join(ROOT, "journal/filters"), "filter");
      importDir(path.join(ROOT, "journal/trades"), "trade");
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    console.error("journal backfill failed:", (err as Error).message);
  }
}

export function appendJournal(kind: JournalKind, text: string): void {
  ensureBackfill();
  getDb()
    .prepare("INSERT INTO journal (at, kind, text) VALUES (?,?,?)")
    .run(new Date().toISOString(), kind, text);
}
