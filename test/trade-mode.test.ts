import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadTradeConfig,
  resolveTradeMode,
  tradingActive,
} from "../src/trade/config.js";

// Isolate the trade-mode env vars around each case.
const KEYS = ["TRADE_MODE", "TRADE_MODE_ROBINHOOD", "TRADE_MODE_SOLANA"];
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

  it("global off + one chain live: only that chain trades", () => {
    process.env.TRADE_MODE_ROBINHOOD = "live";
    const c = loadTradeConfig();
    expect(c.mode).toBe("off");
    expect(resolveTradeMode(c, "robinhood")).toBe("live");
    expect(resolveTradeMode(c, "solana")).toBe("off");
    expect(tradingActive(c)).toBe(true);
  });
});
