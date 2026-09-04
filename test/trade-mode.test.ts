import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadTradeConfig,
  paperStartFor,
  resolveTradeMode,
  tradingActive,
} from "../src/trade/config.js";

// Isolate the trade-mode env vars around each case.
const KEYS = [
  "TRADE_MODE",
  "TRADE_MODES",
  "TRADE_MODE_ROBINHOOD",
  "TRADE_MODE_SOLANA",
  "TRADE_SIZE_PCT",
  "TRADE_PAPER_STARTS",
  "TRADE_PAPER_START_USD",
];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("per-chain trade mode", () => {
  it("default off: nothing trades", () => {
    const c = loadTradeConfig();
    expect(resolveTradeMode(c, "robinhood")).toBe("off");
    expect(tradingActive(c)).toBe(false);
  });

  it("global paper applies to every chain without override", () => {
    process.env.TRADE_MODE = "paper";
    const c = loadTradeConfig();
    expect(resolveTradeMode(c, "robinhood")).toBe("paper");
    expect(resolveTradeMode(c, "solana")).toBe("paper");
    expect(tradingActive(c)).toBe(true);
  });

  it("per-chain override wins over the global default", () => {
    process.env.TRADE_MODE = "paper";
    process.env.TRADE_MODE_ROBINHOOD = "live";
    const c = loadTradeConfig();
    expect(resolveTradeMode(c, "robinhood")).toBe("live");
    expect(resolveTradeMode(c, "solana")).toBe("paper");
  });

  it("TRADE_MODES compact form parses chain:mode pairs", () => {
    process.env.TRADE_MODE = "paper";
    process.env.TRADE_MODES = "robinhood:live, solana:off";
    const c = loadTradeConfig();
    expect(resolveTradeMode(c, "robinhood")).toBe("live");
    expect(resolveTradeMode(c, "solana")).toBe("off");
    expect(resolveTradeMode(c, "bsc")).toBe("paper"); // falls to global default
  });

  it("sizePct + per-chain paper starts parse", () => {
    process.env.TRADE_SIZE_PCT = "0.25";
    process.env.TRADE_PAPER_START_USD = "1000";
    process.env.TRADE_PAPER_STARTS = "robinhood:5000, bsc:200";
    const c = loadTradeConfig();
    expect(c.sizePct).toBe(0.25);
    expect(paperStartFor(c, "robinhood")).toBe(5000);
    expect(paperStartFor(c, "bsc")).toBe(200);
    expect(paperStartFor(c, "solana")).toBe(1000); // falls to global default
  });

  it("global off + one chain live: only that chain trades", () => {
    process.env.TRADE_MODE_ROBINHOOD = "live";
    const c = loadTradeConfig();
    expect(c.mode).toBe("off");
    expect(resolveTradeMode(c, "robinhood")).toBe("live");
    expect(resolveTradeMode(c, "solana")).toBe("off");
    expect(tradingActive(c)).toBe(true);
  });
});
