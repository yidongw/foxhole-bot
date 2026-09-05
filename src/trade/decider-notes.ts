import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dbPath, getDb } from "../lib/db.js";

/**
 * Decider personalization notes. The base prompt (decider.ts) is a GENERIC
 * default that ships in the public repo; a user's own trading calibrations —
 * specific post-mortems, size rules, per-strategy lessons — are rows here,
 * appended to the prompt at spawn time. Add/remove a note = insert/disable a
 * row; no code change (exactly the design the user asked for).
 *
 * These are per-user and must NOT ship in git. On first use, an optional
 * gitignored seed file (data/decider-notes.seed.json — an array of
 * {text, ord?, enabled?}) is imported once. A fork with no seed file gets a
 * clean default prompt.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function seedPath(): string {
  return process.env.DECIDER_NOTES_SEED ?? path.resolve(__dirname, "../../data/decider-notes.seed.json");
}

interface SeedNote {
  text: string;
  ord?: number;
  enabled?: boolean;
}

const seeded = new Set<string>();
function ensureSeeded(): void {
  const p = dbPath();
  if (seeded.has(p)) return;
  seeded.add(p);
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM decider_notes").get() as { n: number }).n;
    const file = seedPath();
    if (n === 0 && existsSync(file)) {
      const notes = JSON.parse(readFileSync(file, "utf8")) as SeedNote[];
      const ins = db.prepare("INSERT INTO decider_notes (at, enabled, ord, text) VALUES (?,?,?,?)");
      notes.forEach((s, i) =>
        ins.run(new Date().toISOString(), s.enabled === false ? 0 : 1, s.ord ?? i, s.text),
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    console.error("decider notes seed failed:", (err as Error).message);
  }
}

/** Enabled notes, ordered — appended to the prompt at spawn (sync; getDb is sync). */
export function loadDeciderNotes(): string[] {
  try {
    ensureSeeded();
    return (getDb()
      .prepare("SELECT text FROM decider_notes WHERE enabled=1 ORDER BY ord, id")
      .all() as unknown as { text: string }[]).map((r) => r.text);
  } catch {
    return [];
  }
}

export interface DeciderNoteRow {
  id: number;
  enabled: number;
  ord: number;
  text: string;
}

export function listDeciderNotes(): DeciderNoteRow[] {
  ensureSeeded();
  return getDb()
    .prepare("SELECT id, enabled, ord, text FROM decider_notes ORDER BY ord, id")
    .all() as unknown as DeciderNoteRow[];
}

export function addDeciderNote(text: string, ord = 100): number {
  ensureSeeded();
  const r = getDb()
    .prepare("INSERT INTO decider_notes (at, enabled, ord, text) VALUES (?,?,?,?)")
    .run(new Date().toISOString(), 1, ord, text);
  return Number(r.lastInsertRowid);
}

/** Enable/disable a note (UPDATE → history keeps the prior version). */
export function setDeciderNoteEnabled(id: number, enabled: boolean): boolean {
  ensureSeeded();
  const r = getDb()
    .prepare("UPDATE decider_notes SET enabled=? WHERE id=?")
    .run(enabled ? 1 : 0, id);
  return r.changes > 0;
}

/** Delete a note (DELETE → history keeps it). */
export function deleteDeciderNote(id: number): boolean {
  ensureSeeded();
  const r = getDb().prepare("DELETE FROM decider_notes WHERE id=?").run(id);
  return r.changes > 0;
}
