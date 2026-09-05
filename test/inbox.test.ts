import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  alertPricesByToken,
  appendAiInboxNews,
  appendAiInboxPerp,
  appendAiInboxSmartMoney,
  archiveAiInbox,
  readAiInbox,
} from "../src/notify/ai-inbox.js";
import { resetDbForTest } from "../src/lib/db.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "inbox-"));
  process.env.FOXHOLE_DB_PATH = path.join(dir, "foxhole.db");
  // Point legacy-import sources at non-existent paths (unset would fall back to
  // the real data/ai-inbox*.jsonl and contaminate the test db).
  process.env.AI_INBOX_JSONL = path.join(dir, "none-inbox.jsonl");
  process.env.AI_INBOX_PROCESSED_JSONL = path.join(dir, "none-processed.jsonl");
  resetDbForTest();
});

afterEach(() => {
  resetDbForTest();
  delete process.env.FOXHOLE_DB_PATH;
  delete process.env.AI_INBOX_JSONL;
  delete process.env.AI_INBOX_PROCESSED_JSONL;
  rmSync(dir, { recursive: true, force: true });
});

describe("inbox queue", () => {
  it("append → read active → archive → read empty, preserving kinds", async () => {
    await appendAiInboxSmartMoney({
      chain: "bsc",
      address: "0xCOIN",
      symbol: "FOO",
      reasons: ["3 wallets bought"],
      distinct: 3,
    });
    await appendAiInboxNews({ title: "hack", url: "http://x", reasons: ["rug"], negative: true });
    await appendAiInboxPerp({
      source: "oi-anomaly",
      symbol: "AKE",
      side: "long",
      score: 80,
      metrics: { oi: 1 },
      reasons: ["oi spike"],
    });

    const active = await readAiInbox();
    expect(active).toHaveLength(3);
    const kinds = active.map((s) => (s as { kind?: string }).kind ?? "signal").sort();
    expect(kinds).toEqual(["news", "perp-signal", "signal"]);

    await archiveAiInbox();
    expect(await readAiInbox()).toHaveLength(0);
  });

  it("alertPricesByToken returns earliest priceUsd per address across all rows", async () => {
    // appendAiInbox needs a SignalEvaluation; craft a minimal one.
    const { appendAiInbox } = await import("../src/notify/ai-inbox.js");
    const mkEv = (address: string, price: number) =>
      ({
        input: {
          chain: "bsc",
          address,
          symbol: "FOO",
          priceUsd: price,
          liquidityUsd: 1000,
          volume24hUsd: 500,
          primaryPairAddress: "0xpair",
        },
        score: 60,
        triggers: ["ai_decision"],
        reasons: ["r"],
      }) as never;

    await appendAiInbox(mkEv("0xAbC", 10));
    await archiveAiInbox();
    await appendAiInbox(mkEv("0xabc", 99)); // later, same token, different price

    const prices = await alertPricesByToken();
    expect(prices.get("0xabc")).toBe(10); // earliest wins
  });

  it("imports legacy inbox jsonl once (active + archived)", async () => {
    writeFileSync(
      process.env.AI_INBOX_JSONL!,
      JSON.stringify({ at: new Date().toISOString(), chain: "bsc", address: "0xACT", liquidityUsd: 0, volume24hUsd: 0, score: 60, triggers: [], reasons: [] }) + "\n",
    );
    writeFileSync(
      process.env.AI_INBOX_PROCESSED_JSONL!,
      JSON.stringify({ at: new Date().toISOString(), chain: "bsc", address: "0xOLD", liquidityUsd: 0, volume24hUsd: 0, score: 60, triggers: [], reasons: [] }) + "\n",
    );
    resetDbForTest();
    const active = await readAiInbox();
    expect(active).toHaveLength(1); // only the un-archived one
    expect((active[0] as { address: string }).address).toBe("0xACT");
  });
});
