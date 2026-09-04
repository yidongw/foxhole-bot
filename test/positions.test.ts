import { describe, expect, it } from "vitest";

import { mergeExitIntoFresh, type Position } from "../src/trade/positions.js";


describe("mergeExitIntoFresh (lost-update race clamp)", () => {
  const base = (): Position => ({
    id: "t-1", mode: "paper", token: "0xabc", trigger: "t",
    openedAt: new Date().toISOString(), entryPriceUsd: 1,
    amountTokens: 100, costUsd: 100, highWaterUsd: 1, exits: [], status: "open",
  });
  const exit = (fraction: number, proceedsUsd: number) => ({
    at: new Date().toISOString(), priceUsd: 1, fraction, proceedsUsd, reason: "test",
  });

  it("applies a snapshot exit fully when nothing changed", () => {
    const fp = base();
    const applied = mergeExitIntoFresh(fp, exit(1, 100));
    expect(applied?.fraction).toBe(1);
    expect(fp.status).toBe("closed");
  });

  it("clamps to the fresh remaining fraction and scales proceeds", () => {
    const fp = base();
    fp.exits.push(exit(0.6, 60)); // concurrent CLI already sold 60%
    const applied = mergeExitIntoFresh(fp, exit(1, 100)); // our tick decided full exit
    expect(applied?.fraction).toBeCloseTo(0.4);
    expect(applied?.proceedsUsd).toBeCloseTo(40);
    expect(fp.status).toBe("closed");
  });

  it("absorbs nothing into an already fully-exited position (no resurrection)", () => {
    const fp = base();
    fp.exits.push(exit(1, 100));
    fp.status = "closed";
    expect(mergeExitIntoFresh(fp, exit(0.5, 50))).toBeUndefined();
    expect(fp.exits.length).toBe(1);
  });
});

describe("withFileLock mutual exclusion", () => {
  it("serializes concurrent mutations (no lost update)", async () => {
    const { withFileLock } = await import("../src/lib/file-lock.js");
    const { mkdtemp, readFile: rf, writeFile: wf } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(tmpdir() + "/lock-test-");
    const data = dir + "/counter.json";
    await wf(data, "0");
    const bump = () =>
      withFileLock(dir + "/counter.lock", async () => {
        const n = Number(await rf(data, "utf8"));
        await new Promise((r) => setTimeout(r, 20)); // widen the race window
        await wf(data, String(n + 1));
      });
    await Promise.all([bump(), bump(), bump(), bump(), bump()]);
    expect(Number(await rf(data, "utf8"))).toBe(5);
  });
});
