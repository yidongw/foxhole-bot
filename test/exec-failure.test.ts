import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { classifyFailure, recordExecFailure } from "../src/trade/exec-failure.js";
import { getDb, resetDbForTest } from "../src/lib/db.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "execfail-"));
  process.env.FOXHOLE_DB_PATH = path.join(dir, "foxhole.db");
  delete process.env.AI_REPAIR; // don't spawn a repair agent in tests
  resetDbForTest();
});

afterEach(() => {
  resetDbForTest();
  delete process.env.FOXHOLE_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("classifyFailure", () => {
  it("flags routing gaps as structural", () => {
    expect(classifyFailure("hoodchain NoRouteError: v4-only pool, no v3 route")).toBe("structural");
    expect(classifyFailure("no aggregator route available")).toBe("structural");
  });
  it("flags external hiccups as transient", () => {
    expect(classifyFailure("gmgn 429 rate-limit ban")).toBe("transient");
    expect(classifyFailure("ETIMEDOUT socket hang up")).toBe("transient");
  });
  it("defaults to unknown", () => {
    expect(classifyFailure("some unexpected revert 0xdeadbeef")).toBe("unknown");
  });
});

describe("recordExecFailure", () => {
  it("persists a classified row (no repair agent when AI_REPAIR unset)", async () => {
    await recordExecFailure({
      chain: "robinhood",
      token: "0xABC",
      symbol: "FOO",
      pool: "0xpool",
      reason: "LI.FI revert; hoodchain NoRouteError v4-only pool",
    });
    const rows = getDb()
      .prepare("SELECT chain, token, symbol, kind, repair_status FROM exec_failures")
      .all() as unknown as { chain: string; token: string; symbol: string; kind: string; repair_status: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("structural");
    expect(rows[0].token).toBe("0xabc"); // lowercased
    expect(rows[0].repair_status).toBeNull(); // AI_REPAIR unset → not dispatched
  });
});
