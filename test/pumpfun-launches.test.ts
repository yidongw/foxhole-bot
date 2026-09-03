import { describe, expect, it } from "vitest";

import {
  addPumpProbation,
  formatPumpLaunchDigest,
  type PumpLaunch,
  type PumpWatchEntry,
} from "../src/chains/solana/pumpfun-launches.js";

function launch(
  mint: string,
  symbol: string,
  graduated = false,
): PumpLaunch {
  return {
    mint,
    symbol,
    name: symbol,
    creator: "Creator1111111111111111111111111111111111111",
    createdAt: 1_788_000_000_000,
    marketCapUsd: 20_000,
    graduated,
  };
}

describe("addPumpProbation", () => {
  it("adds fresh mints as unverified probation entries", () => {
    const entries: PumpWatchEntry[] = [];
    const added = addPumpProbation(
      [launch("Aaa111pump", "AAA"), launch("Bbb222pump", "BBB")],
      entries,
    );
    expect(added).toBe(2);
    expect(entries).toHaveLength(2);
    expect(entries[0].verified).toBe(false);
    expect(entries[0].symbol).toBe("AAA");
  });

  it("marks already-graduated launches verified on entry", () => {
    const entries: PumpWatchEntry[] = [];
    addPumpProbation([launch("Ggg333pump", "GRAD", true)], entries);
    expect(entries[0].verified).toBe(true);
  });

  it("dedupes against existing entries case-insensitively", () => {
    const entries: PumpWatchEntry[] = [
      {
        address: "Aaa111pump",
        firstSeen: new Date().toISOString(),
        verified: true,
        attempts: 0,
      },
    ];
    const added = addPumpProbation(
      [launch("AAA111PUMP", "AAA"), launch("Ccc444pump", "CCC")],
      entries,
    );
    expect(added).toBe(1);
    expect(entries).toHaveLength(2);
  });
});

describe("formatPumpLaunchDigest", () => {
  it("summarizes launches with a SOL tag and symbol sample", () => {
    const digest = formatPumpLaunchDigest([
      launch("Aaa111pump", "AAA"),
      launch("Bbb222pump", "BBB"),
    ]);
    expect(digest).toContain("[SOL]");
    expect(digest).toContain("2 new");
    expect(digest).toContain("AAA, BBB");
  });
});
