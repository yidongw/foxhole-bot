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

describe("decideExtremePrice (two-independent-source glitch guard)", () => {
  const HW = 0.0204;

  it("corrects a crash read when any source is in-band (OPTIMUS 12:27)", async () => {
    const { decideExtremePrice } = await import("../src/trade/engine.js");
    expect(decideExtremePrice(HW, 0.002828, 0.0206, undefined)).toBe(0.0206);
    expect(decideExtremePrice(HW, 0.002828, 0.002828, 0.0206)).toBe(0.0206);
  });

  it("lets a true rug through when both sources independently agree", async () => {
    const { decideExtremePrice } = await import("../src/trade/engine.js");
    expect(decideExtremePrice(HW, 0.001, 0.0011, 0.0009)).toBe(0.001);
  });

  it("skips when sources are missing or only one confirms the extreme", async () => {
    const { decideExtremePrice } = await import("../src/trade/engine.js");
    expect(decideExtremePrice(HW, 0.002828, undefined, undefined)).toBeUndefined();
    expect(decideExtremePrice(HW, 0.002828, 0.0029, undefined)).toBeUndefined();
  });

  it("skips when sources are extreme on the OPPOSITE side (contradiction)", async () => {
    const { decideExtremePrice } = await import("../src/trade/engine.js");
    expect(decideExtremePrice(HW, 0.002828, 0.15, 0.16)).toBeUndefined();
  });

  it("corrects a fake pump when a source is in-band (MarsCoin $149)", async () => {
    const { decideExtremePrice } = await import("../src/trade/engine.js");
    expect(decideExtremePrice(0.1379, 149.29, 0.1224, undefined)).toBe(0.1224);
  });

  it("accepts a real 6x pump both sources confirm", async () => {
    const { decideExtremePrice } = await import("../src/trade/engine.js");
    expect(decideExtremePrice(0.1, 0.62, 0.6, 0.65)).toBe(0.62);
  });
});
