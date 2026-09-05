import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  addDeciderNote,
  deleteDeciderNote,
  listDeciderNotes,
  loadDeciderNotes,
  setDeciderNoteEnabled,
} from "../src/trade/decider-notes.js";
import { getDb, resetDbForTest } from "../src/lib/db.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dnotes-"));
  process.env.FOXHOLE_DB_PATH = path.join(dir, "foxhole.db");
  const seed = path.join(dir, "seed.json");
  writeFileSync(seed, JSON.stringify([{ text: "lesson A", ord: 1 }, { text: "lesson B", ord: 2 }]));
  process.env.DECIDER_NOTES_SEED = seed;
  resetDbForTest();
});

afterEach(() => {
  resetDbForTest();
  delete process.env.FOXHOLE_DB_PATH;
  delete process.env.DECIDER_NOTES_SEED;
  rmSync(dir, { recursive: true, force: true });
});

describe("decider notes", () => {
  it("imports the seed once and returns enabled notes in order", () => {
    expect(loadDeciderNotes()).toEqual(["lesson A", "lesson B"]);
  });

  it("add / disable / delete, with history on modify+delete", () => {
    const id = addDeciderNote("lesson C", 3);
    expect(loadDeciderNotes()).toEqual(["lesson A", "lesson B", "lesson C"]);

    setDeciderNoteEnabled(id, false); // UPDATE → history
    expect(loadDeciderNotes()).toEqual(["lesson A", "lesson B"]); // C hidden
    expect(listDeciderNotes()).toHaveLength(3);

    deleteDeciderNote(id); // DELETE → history
    const hist = getDb()
      .prepare("SELECT _op FROM decider_notes_history ORDER BY hid")
      .all() as unknown as { _op: string }[];
    expect(hist.map((h) => h._op)).toEqual(["update", "delete"]);
  });

  it("no seed file → clean empty default (a fork gets no notes)", () => {
    delete process.env.DECIDER_NOTES_SEED;
    process.env.DECIDER_NOTES_SEED = path.join(dir, "absent.json");
    resetDbForTest();
    expect(loadDeciderNotes()).toEqual([]);
  });
});
