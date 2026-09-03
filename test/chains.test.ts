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
  paperStartUsd: 1000,
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

describe("post-pump entry veto", () => {
  it("refuses entries carrying the post_pump trigger", () => {
    process.env.TRADE_CHAINS = "robinhood,solana";
    const v = checkEntry(CONFIG, { version: 1, positions: [] }, {
      token: "0xAbC0000000000000000000000000000000000002",
      chain: "solana",
      symbol: "LATE",
      priceUsd: 1,
      liquidityUsd: 100_000,
      triggers: ["lock_strong", "post_pump"],
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/post-pump/);
  });
});

describe("falling-knife entry veto", () => {
  it("refuses entries carrying the falling_knife trigger", () => {
    process.env.TRADE_CHAINS = "robinhood,solana";
    const v = checkEntry(CONFIG, { version: 1, positions: [] }, {
      token: "0xAbC0000000000000000000000000000000000003",
      chain: "solana",
      symbol: "KNIFE",
      priceUsd: 1,
      liquidityUsd: 100_000,
      triggers: ["lock_strong", "falling_knife"],
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/falling knife/);
  });
});

describe("24h capital-at-risk cap", () => {
  const now = new Date().toISOString();
  const closedRoundTrip = {
    id: "p1", token: "0xoldtoken", chain: "robinhood" as const, symbol: "OLD",
    openedAt: now, costUsd: 50, amountTokens: 100, entryPriceUsd: 0.5,
    highPriceUsd: 0.6, status: "closed" as const,
    exits: [{ at: now, fraction: 1, priceUsd: 0.55, proceedsUsd: 55, reason: "tp" }],
  };
  const candidate = {
    token: "0xAbC0000000000000000000000000000000000004",
    chain: "robinhood", symbol: "NEW", priceUsd: 1, liquidityUsd: 100_000,
    triggers: ["lock_strong"],
  };

  it("closed round-trips free their window allowance", () => {
    const file = {
      version: 1 as const,
      positions: [1, 2, 3, 4].map((i) => ({ ...closedRoundTrip, id: `p${i}`, token: `0xt${i}` })),
    };
    // gross entries $200 but all returned with proceeds — new entry allowed
    expect(checkEntry({ ...CONFIG }, file, candidate).ok).toBe(true);
  });

  it("rugged (zero-proceed) entries still bind the cap", () => {
    const rug = { ...closedRoundTrip, exits: [] };
    const file = {
      version: 1 as const,
      positions: [1, 2, 3, 4].map((i) => ({ ...rug, id: `p${i}`, token: `0xt${i}`, status: "closed" as const })),
    };
    const v = checkEntry({ ...CONFIG }, file, candidate);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/capital-at-risk/);
  });
});
