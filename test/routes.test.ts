import { afterEach, describe, expect, it } from "vitest";

import { resolveWebhook } from "../src/notify/routes.js";

const VARS = [
  "DISCORD_WEBHOOK_URL",
  "DISCORD_SIGNAL_WEBHOOK_URL",
  "DISCORD_SIGNAL_WEBHOOK_URL_SOLANA",
  "DISCORD_TRADE_WEBHOOK_URL",
  "DISCORD_TRADE_WEBHOOK_URL_BSC",
  "DISCORD_FILTER_WEBHOOK_URL",
  "DISCORD_REVIEW_WEBHOOK_URL",
  "DISCORD_FEED_WEBHOOK_URL",
];

afterEach(() => {
  for (const v of VARS) delete process.env[v];
});

describe("resolveWebhook", () => {
  it("prefers per-chain over global over legacy", () => {
    process.env.DISCORD_WEBHOOK_URL = "legacy";
    process.env.DISCORD_SIGNAL_WEBHOOK_URL = "global";
    process.env.DISCORD_SIGNAL_WEBHOOK_URL_SOLANA = "sol";
    expect(resolveWebhook("signal", "solana")).toBe("sol");
    expect(resolveWebhook("signal", "bsc")).toBe("global");
    delete process.env.DISCORD_SIGNAL_WEBHOOK_URL;
    expect(resolveWebhook("signal", "bsc")).toBe("legacy");
  });

  it("trade falls back per-chain → global → main webhook", () => {
    process.env.DISCORD_WEBHOOK_URL = "main";
    expect(resolveWebhook("trade", "bsc")).toBe("main");
    process.env.DISCORD_TRADE_WEBHOOK_URL = "trade-global";
    expect(resolveWebhook("trade", "bsc")).toBe("trade-global");
    process.env.DISCORD_TRADE_WEBHOOK_URL_BSC = "trade-bsc";
    expect(resolveWebhook("trade", "bsc")).toBe("trade-bsc");
  });

  it("review uses its own webhook, no filter-channel fallback (thread-only)", () => {
    // review 输出改为 thread-only:不再回退到 filter 频道(2026-09-04)。
    process.env.DISCORD_FILTER_WEBHOOK_URL = "filter";
    expect(resolveWebhook("review")).toBeUndefined();
    process.env.DISCORD_REVIEW_WEBHOOK_URL = "review";
    expect(resolveWebhook("review")).toBe("review");
  });

  it("feed stays off without explicit config", () => {
    process.env.DISCORD_WEBHOOK_URL = "main";
    expect(resolveWebhook("feed", "solana")).toBeUndefined();
    process.env.DISCORD_FEED_WEBHOOK_URL = "feed";
    expect(resolveWebhook("feed", "solana")).toBe("feed");
  });
});
