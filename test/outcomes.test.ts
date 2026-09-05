import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadLabeledOutcomes,
  loadPendingOutcomes,
  recordAlertOutcome,
} from "../src/review/ledger.js";
import { saveMissedCases, type ClassifiedMover } from "../src/review/movers.js";
import { resetDbForTest } from "../src/lib/db.js";

let dir: string;

const analysis = (address: string) =>
  ({ address, chain: "bsc", symbol: "FOO", priceUsd: 1, volume24hUsd: 100, liquidityUsd: 5000, primaryPairAddress: undefined }) as never;
const evalAlert = { level: "alert", score: 70, triggers: ["x"] } as never;

const mover = (address: string, kind: ClassifiedMover["kind"] = "coverage_miss"): ClassifiedMover =>
  ({ chain: "bsc", poolId: "0xp", address, symbol: "FOO", priceChange24h: 300, volume24hUsd: 1e5, liquidityUsd: 5e4, fdvUsd: 2e7, kind }) as ClassifiedMover;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "outcomes-"));
  process.env.FOXHOLE_DB_PATH = path.join(dir, "foxhole.db");
  // Point every legacy import source at a non-existent path (no backfill).
  for (const v of [
    "OUTCOMES_PENDING_PATH",
    "OUTCOMES_LABELED_PATH",
    "OUTCOMES_MISSED_PATH",
    "OUTCOMES_EXIT_REVIEW_PATH",
  ]) {
    process.env[v] = path.join(dir, `none-${v}.json`);
  }
  resetDbForTest();
});

afterEach(() => {
  resetDbForTest();
  delete process.env.FOXHOLE_DB_PATH;
  for (const v of ["OUTCOMES_PENDING_PATH", "OUTCOMES_LABELED_PATH", "OUTCOMES_MISSED_PATH", "OUTCOMES_EXIT_REVIEW_PATH"]) {
    delete process.env[v];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("outcomes ledger on SQLite", () => {
  it("records a pending alert and dedups the same token within 24h", async () => {
    await recordAlertOutcome(analysis("0xABC"), evalAlert);
    await recordAlertOutcome(analysis("0xabc"), evalAlert); // dup (case-insensitive)
    const pending = await loadPendingOutcomes();
    expect(pending.filter((r) => r.address.toLowerCase() === "0xabc")).toHaveLength(1);
    expect(await loadLabeledOutcomes()).toHaveLength(0);
  });

  it("does not record below alert level", async () => {
    await recordAlertOutcome(analysis("0xDEF"), { level: "watch", score: 10, triggers: [] } as never);
    expect(await loadPendingOutcomes()).toHaveLength(0);
  });
});

describe("saveMissedCases on SQLite", () => {
  it("inserts new cases and dedups by chain:address:day", async () => {
    const added1 = await saveMissedCases([mover("0xAAA"), mover("0xBBB")]);
    expect(added1).toHaveLength(2);
    const added2 = await saveMissedCases([mover("0xaaa")]); // same token same day
    expect(added2).toHaveLength(0);
  });

  it("skips alerted / ladder / low-fdv movers", async () => {
    const added = await saveMissedCases([
      mover("0x1", "alerted"),
      { ...mover("0x2"), ladder: true },
      { ...mover("0x3"), fdvUsd: 1000 },
    ]);
    expect(added).toHaveLength(0);
  });
});
