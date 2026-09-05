import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { addGoodToken, goodTokensForChain, loadGoodTokens } from "../src/smartmoney/good-tokens.js";
import { addToDenylist, isDenylisted, loadDenylist, removeFromDenylist } from "../src/review/denylist.js";
import { getDb, resetDbForTest } from "../src/lib/db.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "curated-"));
  process.env.FOXHOLE_DB_PATH = path.join(dir, "foxhole.db");
  process.env.GOOD_TOKENS_PATH = path.join(dir, "none-good.json");
  process.env.DENYLIST_PATH = path.join(dir, "none-deny.json");
  resetDbForTest();
});

afterEach(() => {
  resetDbForTest();
  delete process.env.FOXHOLE_DB_PATH;
  delete process.env.GOOD_TOKENS_PATH;
  delete process.env.DENYLIST_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("good-tokens on SQLite", () => {
  it("adds, dedups (chain:address), filters by chain", async () => {
    expect((await addGoodToken({ chain: "bsc", address: "0xAAA", symbol: "A" })).added).toBe(true);
    expect((await addGoodToken({ chain: "bsc", address: "0xaaa" })).added).toBe(false);
    await addGoodToken({ chain: "sol", address: "Sol1" });
    expect(await loadGoodTokens()).toHaveLength(2);
    expect(await goodTokensForChain("bsc")).toHaveLength(1);
  });
});

describe("denylist on SQLite (audited)", () => {
  it("adds, dedups, queries, and keeps removed entries in history", async () => {
    await addToDenylist([
      { chain: "bsc", address: "0xBAD", reason: "rug" },
      { chain: "bsc", address: "0xbad", reason: "dup" }, // same key
    ]);
    expect(await loadDenylist()).toHaveLength(1);
    expect(await isDenylisted("bsc", "0xBAD")).toBe(true);
    expect(await isDenylisted("bsc", "0xok")).toBe(false);

    expect(await removeFromDenylist("bsc", "0xBAD")).toBe(true);
    expect(await isDenylisted("bsc", "0xbad")).toBe(false);
    const hist = getDb()
      .prepare("SELECT _op, data FROM review_denylist_history WHERE key=? ORDER BY hid")
      .all("bsc:0xbad") as unknown as { _op: string; data: string }[];
    expect(hist.map((h) => h._op)).toEqual(["delete"]);
    expect((JSON.parse(hist[0].data) as { reason: string }).reason).toBe("rug");
  });
});
