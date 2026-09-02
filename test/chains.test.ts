import { afterEach, describe, expect, it } from "vitest";

import { enabledChains, tradeEnabledChains } from "../src/chains/adapter.js";
import { selectDeepestBasePair } from "../src/chains/generic-analysis.js";
import { checkEntry } from "../src/trade/risk.js";
import type { TradeConfig } from "../src/trade/config.js";
import type { DexPair } from "../src/types.js";

const CONFIG: TradeConfig = {
  mode: "paper",
  usdPerTrade: 50,
  maxDailySpendUsd: 200,
  maxOpenPositions: 3,
  minEntryLiquidityUsd: 50_000,
  slippageBps: 100,
  trailStopPct: 0.25,
  hardStopPct: 0.35,
  takeProfits: [],
  maxHoldHours: 96,
  entryTriggers: ["lock_strong"],
  denylist: [],
};

afterEach(() => {
  delete process.env.CHAINS;
  delete process.env.TRADE_CHAINS;
});

describe("chain env parsing", () => {
  it("defaults to robinhood only", () => {
    expect(enabledChains()).toEqual(["robinhood"]);
    expect(tradeEnabledChains()).toEqual(["robinhood"]);
  });

  it("parses CHAINS and drops unknown ids", () => {
    process.env.CHAINS = "robinhood, solana,BSC, dogechain";
    expect(enabledChains()).toEqual(["robinhood", "solana", "bsc"]);
  });

  it("falls back to robinhood when CHAINS has no valid entries", () => {
    process.env.CHAINS = "dogechain";
    expect(enabledChains()).toEqual(["robinhood"]);
  });
});

describe("per-chain trade gating", () => {
  const candidate = {
    token: "0xAbC0000000000000000000000000000000000001",
    chain: "solana",
    symbol: "TEST",
    priceUsd: 1,
    liquidityUsd: 100_000,
    triggers: ["lock_strong"],
  };
  const file = { version: 1 as const, positions: [] };

  it("rejects chains not in TRADE_CHAINS", () => {
    const v = checkEntry(CONFIG, file, candidate);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/TRADE_CHAINS/);
  });

  it("allows chains explicitly enabled", () => {
    process.env.TRADE_CHAINS = "robinhood,solana";
    expect(checkEntry(CONFIG, file, candidate).ok).toBe(true);
  });

  it("legacy candidates without chain default to robinhood", () => {
    const { chain: _chain, ...legacy } = candidate;
    expect(checkEntry(CONFIG, file, legacy).ok).toBe(true);
  });
});

describe("selectDeepestBasePair", () => {
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const pairA: DexPair = {
    baseToken: { address: "MintAAA", symbol: "A" },
    quoteToken: { address: SOL_MINT, symbol: "SOL" },
    liquidity: { usd: 100 },
  };
  const pairB: DexPair = {
    baseToken: { address: "MintAAA", symbol: "A" },
    quoteToken: { address: "usdc", symbol: "USDC" },
    liquidity: { usd: 500 },
  };

  it("picks the deepest base-side pair regardless of quote type", () => {
    expect(selectDeepestBasePair([pairA, pairB], "MintAAA")?.quoteToken?.symbol).toBe(
      "USDC",
    );
  });

  it("returns undefined when the token is quote-side only", () => {
    expect(selectDeepestBasePair([pairA], SOL_MINT)).toBeUndefined();
  });
});
