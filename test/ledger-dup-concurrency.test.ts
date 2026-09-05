import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  findOpen,
  mutatePositions,
  openPositions,
  loadPositions,
  type Position,
} from "../src/trade/positions.js";
import { resetDbForTest } from "../src/lib/db.js";

/**
 * The fix behind aiBuy's in-lock dup re-check: checkEntry's 一币一仓 gate runs on
 * a PRE-lock snapshot, so two concurrent deciders could both pass it for the
 * same new token and double-open it. The guard re-checks findOpen INSIDE the
 * ledger lock. This proves the mechanism it relies on: withFileLock serializes
 * the two mutations, so the second sees the first's committed position.
 */

let dir: string;

function openPos(token: string): Position {
  return {
    id: `${token}-${Math.random()}`,
    mode: "paper",
    chain: "robinhood",
    token,
    symbol: "TESTCOIN",
    trigger: "ai_decision: test",
    openedAt: new Date().toISOString(),
    entryPriceUsd: 1,
    amountTokens: 100,
    costUsd: 10,
    highWaterUsd: 1,
    exits: [],
    status: "open",
  };
}

/** Mirror of aiBuy's locked guard: reject when the token is already open. */
function guardedOpen(token: string) {
  return mutatePositions((f) => {
    if (findOpen(f, token)) return "dup" as const;
    f.positions.push(openPos(token));
    return "ok" as const;
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
  process.env.FOXHOLE_DB_PATH = path.join(dir, "foxhole.db");
  // Point the legacy-import source at a non-existent path so backfill is a
  // no-op (an unset var would fall back to the real data/positions.json).
  process.env.POSITIONS_FILE_PATH = path.join(dir, "none.json");
  resetDbForTest();
});

afterEach(() => {
  resetDbForTest();
  delete process.env.FOXHOLE_DB_PATH;
  delete process.env.POSITIONS_FILE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("concurrent same-token buys open exactly one position", () => {
  it("second concurrent open is rejected as dup, ledger holds one", async () => {
    const [a, b] = await Promise.all([guardedOpen("0xTOKEN"), guardedOpen("0xtoken")]);
    const verdicts = [a.result, b.result].sort();
    expect(verdicts).toEqual(["dup", "ok"]); // exactly one won

    const file = await loadPositions();
    const open = openPositions(file).filter((p) => p.token.toLowerCase() === "0xtoken");
    expect(open).toHaveLength(1);
  });

  it("different tokens both open", async () => {
    const [a, b] = await Promise.all([guardedOpen("0xAAA"), guardedOpen("0xBBB")]);
    expect(a.result).toBe("ok");
    expect(b.result).toBe("ok");
    expect(openPositions(await loadPositions())).toHaveLength(2);
  });
});
