import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendDecision,
  formatRecentDecisions,
  priorVerdict,
  suppressRewake,
} from "../src/trade/decisions.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "decisions-"));
  process.env.DECISIONS_LOG_PATH = path.join(dir, "decisions.jsonl");
});

afterEach(() => {
  delete process.env.DECISIONS_LOG_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("decision journal", () => {
  it("returns the most recent prior verdict for a token, case-insensitive", async () => {
    await appendDecision({ verdict: "skip", chain: "robinhood", token: "0xABC", reason: "太早无量" });
    await appendDecision({ verdict: "skip", chain: "robinhood", token: "0xabc", reason: "还是太早", revisit: "收回$1" });
    const prior = await priorVerdict("robinhood", "0xAbC");
    expect(prior?.reason).toBe("还是太早");
    expect(prior?.revisit).toBe("收回$1");
  });

  it("ignores verdicts older than the window", async () => {
    const old = new Date(Date.now() - 72 * 60 * 60_000).toISOString(); // 72h ago
    writeFileSync(
      process.env.DECISIONS_LOG_PATH!,
      JSON.stringify({ at: old, verdict: "skip", chain: "bsc", token: "0x1", reason: "old" }) + "\n",
    );
    expect(await priorVerdict("bsc", "0x1")).toBeUndefined(); // default 48h window
  });

  it("does not confuse different tokens", async () => {
    await appendDecision({ verdict: "buy", chain: "bsc", token: "0xaaa", reason: "买了" });
    expect(await priorVerdict("bsc", "0xbbb")).toBeUndefined();
  });
});

describe("suppressRewake", () => {
  it("suppresses a re-wake when recently skipped and price barely moved", async () => {
    await appendDecision({
      verdict: "skip",
      chain: "robinhood",
      token: "0x9",
      reason: "太早",
      snap: { price: 100 },
    });
    expect(await suppressRewake("robinhood", "0x9", { price: 105 })).toBe(true); // +5%
  });

  it("does NOT suppress when price moved materially", async () => {
    await appendDecision({
      verdict: "skip",
      chain: "robinhood",
      token: "0x9",
      reason: "太早",
      snap: { price: 100 },
    });
    expect(await suppressRewake("robinhood", "0x9", { price: 130 })).toBe(false); // +30%
  });

  it("does NOT suppress when the prior snapshot has no price (unprovable)", async () => {
    await appendDecision({ verdict: "skip", chain: "robinhood", token: "0x9", reason: "太早" });
    expect(await suppressRewake("robinhood", "0x9", { price: 100 })).toBe(false);
  });

  it("does NOT suppress a prior BUY (only skips gate re-wakes)", async () => {
    await appendDecision({
      verdict: "buy",
      chain: "robinhood",
      token: "0x9",
      reason: "买了",
      snap: { price: 100 },
    });
    expect(await suppressRewake("robinhood", "0x9", { price: 101 })).toBe(false);
  });
});

describe("formatRecentDecisions", () => {
  it("is empty when nothing recent, and renders skips with revisit", async () => {
    expect(await formatRecentDecisions()).toBe("");
    await appendDecision({
      verdict: "skip",
      chain: "bsc",
      token: "0x1",
      symbol: "FOO",
      reason: "无量",
      revisit: "放量再看",
    });
    const out = await formatRecentDecisions();
    expect(out).toContain("FOO");
    expect(out).toContain("放量再看");
  });
});
