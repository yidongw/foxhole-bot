import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  findOpenPerp,
  loadPerpPositions,
  mergePerpExitIntoFresh,
  mutatePerpPositions,
  openPerps,
  remainingFraction,
  type PerpPosition,
} from "../src/venues/hyperliquid/positions.js";
import { resetDbForTest } from "../src/lib/db.js";

let dir: string;

function openPerp(symbol: string): PerpPosition {
  return {
    id: `${symbol}-long-${Math.random()}`,
    mode: "paper",
    venue: "hyperliquid",
    symbol,
    side: "long",
    leverage: 2,
    openedAt: new Date().toISOString(),
    entryPriceUsd: 100,
    sizeUsd: 200,
    sizeCoins: 2,
    marginUsd: 100,
    bestPriceUsd: 100,
    exits: [],
    status: "open",
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "perp-"));
  process.env.FOXHOLE_DB_PATH = path.join(dir, "foxhole.db");
  process.env.PERP_POSITIONS_FILE_PATH = path.join(dir, "none.json"); // no backfill
  resetDbForTest();
});

afterEach(() => {
  resetDbForTest();
  delete process.env.FOXHOLE_DB_PATH;
  delete process.env.PERP_POSITIONS_FILE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("perp ledger on SQLite", () => {
  it("persists across connections and computes helpers", async () => {
    await mutatePerpPositions((f) => {
      f.positions.push(openPerp("AKE"));
      return 0;
    });
    resetDbForTest();
    const f = await loadPerpPositions();
    expect(f.positions).toHaveLength(1);
    expect(openPerps(f)).toHaveLength(1);
    expect(findOpenPerp(f, "ake")?.symbol).toBe("AKE"); // case-insensitive
  });

  it("concurrent same-symbol open → exactly one wins (in-lock dup guard)", async () => {
    const guard = (sym: string) =>
      mutatePerpPositions((f) => {
        if (findOpenPerp(f, sym)) return "dup" as const;
        f.positions.push(openPerp(sym));
        return "ok" as const;
      });
    const [a, b] = await Promise.all([guard("AKE"), guard("ake")]);
    expect([a.result, b.result].sort()).toEqual(["dup", "ok"]);
    const f = await loadPerpPositions();
    expect(openPerps(f).filter((p) => p.symbol === "AKE")).toHaveLength(1);
  });

  it("mergePerpExitIntoFresh clamps to remaining and closes when fully exited", async () => {
    const p = openPerp("AKE");
    const applied = mergePerpExitIntoFresh(p, {
      at: new Date().toISOString(),
      markPriceUsd: 120,
      fraction: 2, // over-asks; clamps to 1
      realizedPnlUsd: 80,
      reason: "tp",
    });
    expect(applied?.fraction).toBe(1);
    expect(applied?.realizedPnlUsd).toBe(40); // scaled by 1/2
    expect(remainingFraction(p)).toBe(0);
    expect(p.status).toBe("closed");
  });
});
