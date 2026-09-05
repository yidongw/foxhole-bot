import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadOverridesFile, saveOverridesFile } from "../src/signals/config.js";
import { appendSmLog, readSmLog } from "../src/smartmoney/log.js";
import { getDb, resetDbForTest } from "../src/lib/db.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tuning-"));
  process.env.FOXHOLE_DB_PATH = path.join(dir, "foxhole.db");
  process.env.SIGNAL_OVERRIDES_PATH = path.join(dir, "none-ov.json");
  process.env.SM_LOG_PATH = path.join(dir, "none-log.jsonl");
  resetDbForTest();
});

afterEach(() => {
  resetDbForTest();
  delete process.env.FOXHOLE_DB_PATH;
  delete process.env.SIGNAL_OVERRIDES_PATH;
  delete process.env.SM_LOG_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("signal-overrides in kv (audited)", () => {
  it("round-trips and keeps prior versions in kv_history", async () => {
    expect(loadOverridesFile()).toBeUndefined();
    saveOverridesFile({ updated_at: "t1", reason: "r1", config: { minVolumeUsd: 111 } });
    expect(loadOverridesFile()?.config.minVolumeUsd).toBe(111);
    saveOverridesFile({ updated_at: "t2", reason: "r2", config: { minVolumeUsd: 222 } });
    expect(loadOverridesFile()?.config.minVolumeUsd).toBe(222);
    // kv audit captured the first (overwritten) version.
    const hist = getDb()
      .prepare("SELECT value FROM kv_history WHERE key='signals:overrides' ORDER BY hid")
      .all() as unknown as { value: string }[];
    expect(hist).toHaveLength(1);
    expect((JSON.parse(hist[0].value) as { config: { minVolumeUsd: number } }).config.minVolumeUsd).toBe(111);
  });
});

describe("smart-money log in sm_log", () => {
  it("appends and range-scans by since", async () => {
    await appendSmLog({ kind: "alert", chain: "bsc", wallet: "0x1", token: "0xT", usd: 100 });
    await appendSmLog({ kind: "trigger", chain: "bsc", wallet: "0x2", token: "0xT", distinct: 2 });
    expect(await readSmLog()).toHaveLength(2);
    // future cutoff → nothing
    expect(await readSmLog(Date.now() + 60_000)).toHaveLength(0);
    // backdate one row and confirm the range scan excludes it
    getDb().prepare("UPDATE sm_log SET at=? WHERE wallet='0x1'").run("2000-01-01T00:00:00.000Z");
    const recent = await readSmLog(Date.now() - 3_600_000);
    expect(recent).toHaveLength(1);
    expect(recent[0].wallet).toBe("0x2");
  });
});
