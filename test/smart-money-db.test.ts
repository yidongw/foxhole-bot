import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  addTrackedWallet,
  disableWallet,
  loadActiveTrackedWallets,
  loadTrackedWallets,
  removeTrackedWallet,
} from "../src/chains/robinhood/smart-money.js";
import { saveConfig } from "../src/smartmoney/config.js";
import { getDb, resetDbForTest } from "../src/lib/db.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sm-"));
  process.env.FOXHOLE_DB_PATH = path.join(dir, "foxhole.db");
  process.env.SMART_MONEY_BOOK_PATH = path.join(dir, "none-book.json"); // absent backfill source
  process.env.SMART_MONEY_CONFIG_PATH = path.join(dir, "none-config.json");
  resetDbForTest();
});

afterEach(() => {
  resetDbForTest();
  delete process.env.FOXHOLE_DB_PATH;
  delete process.env.SMART_MONEY_BOOK_PATH;
  delete process.env.SMART_MONEY_CONFIG_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("smart-money wallet book on SQLite", () => {
  it("adds, dedups, disables, removes — persisting across connections", async () => {
    const a = await addTrackedWallet("0x1111111111111111111111111111111111111111", "whale", "me", "bsc");
    expect(a.added).toBe(true);
    const dup = await addTrackedWallet("0x1111111111111111111111111111111111111111", "again");
    expect(dup.added).toBe(false); // case/checksum-insensitive dedup

    resetDbForTest(); // force reload from disk
    let all = await loadTrackedWallets();
    expect(all).toHaveLength(1);
    expect(all[0].label).toBe("whale");

    await disableWallet("0x1111111111111111111111111111111111111111", "revet");
    expect(await loadActiveTrackedWallets()).toHaveLength(0); // disabled excluded
    expect(await loadTrackedWallets()).toHaveLength(1); // but kept on record

    const rm = await removeTrackedWallet("0x1111111111111111111111111111111111111111");
    expect(rm.removed).toBe(true);
    expect(await loadTrackedWallets()).toHaveLength(0);
  });

  it("keeps prior versions in sm_wallets_history on disable + delete", async () => {
    const addr = "0x3333333333333333333333333333333333333333";
    await addTrackedWallet(addr, "keep", "me", "bsc");
    await disableWallet(addr, "revet"); // UPDATE → history row (pre-disable)
    await removeTrackedWallet(addr); // DELETE → history row (pre-delete)
    const hist = getDb()
      .prepare("SELECT _op, data FROM sm_wallets_history WHERE address=? ORDER BY hid")
      .all(addr.toLowerCase()) as unknown as { _op: string; data: string }[];
    expect(hist.map((h) => h._op)).toEqual(["update", "delete"]);
    // The 'update' history row holds the pre-disable version (not yet disabled).
    expect((JSON.parse(hist[0].data) as { disabled?: boolean }).disabled).toBeUndefined();
    // The 'delete' history row holds the last (disabled) version.
    expect((JSON.parse(hist[1].data) as { disabled?: boolean }).disabled).toBe(true);
  });
});

describe("smart-money filter config on SQLite (kv)", () => {
  it("saveConfig persists to the kv blob", async () => {
    await saveConfig({ defaults: { alertMinUsd: 42 }, chains: {}, wallets: { "0xabc": { aiMinUsd: 7 } } });
    const row = getDb().prepare("SELECT value FROM kv WHERE key='smartmoney:config'").get() as
      | { value: string }
      | undefined;
    expect(row).toBeTruthy();
    const cfg = JSON.parse(row!.value) as { defaults: { alertMinUsd: number }; wallets: Record<string, { aiMinUsd: number }> };
    expect(cfg.defaults.alertMinUsd).toBe(42);
    expect(cfg.wallets["0xabc"].aiMinUsd).toBe(7);
  });
});
