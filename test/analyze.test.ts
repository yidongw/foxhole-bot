import { describe, expect, it } from "vitest";

import { selectPrimaryPair } from "../src/long/analyze-token.js";
import type { DexPair } from "../src/types.js";

const BONER = "0x98096d17e191B3dA1d5f99a6D7b3584351b11E18";
const HIMS = "0xCceE82fE024c36fA15E1005edE3E9e4787e23D09";

const bonerHims: DexPair = {
  baseToken: { address: BONER, symbol: "BONER" },
  quoteToken: { address: HIMS, symbol: "HIMS" },
  liquidity: { usd: 2_000_000 },
};
const bonerWeth: DexPair = {
  baseToken: { address: BONER, symbol: "BONER" },
  quoteToken: { address: "0x1", symbol: "WETH" },
  liquidity: { usd: 5_000_000 },
};

describe("selectPrimaryPair", () => {
  it("prefers stock-quoted pairs over deeper stable/gas pairs", () => {
    const primary = selectPrimaryPair([bonerWeth, bonerHims], BONER);
    expect(primary?.quoteToken?.symbol).toBe("HIMS");
  });

  it("falls back to non-stock pairs when no stock pair exists", () => {
    const primary = selectPrimaryPair([bonerWeth], BONER);
    expect(primary?.quoteToken?.symbol).toBe("WETH");
  });

  it("never returns a pair where the token is only the quote side", () => {
    // Analyzing HIMS must not pick up BONER/HIMS (the regression that
    // paper-traded the HIMS stock token as "BONER").
    expect(selectPrimaryPair([bonerHims, bonerWeth], HIMS)).toBeUndefined();
  });
});

describe("selectPrimaryPair — PONS regression", () => {
  const PONS = "0x39dBED3a2bd333467115dE45665cC57F813C4571";
  const ponsWeth: DexPair = {
    baseToken: { address: PONS, symbol: "PONS" },
    quoteToken: { address: "0x1", symbol: "WETH" },
    liquidity: { usd: 5_100_000 },
  };
  const ponsAi: DexPair = {
    baseToken: { address: PONS, symbol: "PONS" },
    quoteToken: { address: "0x2", symbol: "AI" },
    liquidity: { usd: 189_000 },
  };

  it("tiny meme-quote side pools do not hijack primary selection", () => {
    // PONS was analyzed off a $189K PONS/AI pool ($31K vol) instead of its
    // $5.1M WETH main pool ($24M/day) — score 0, invisible to every signal.
    const primary = selectPrimaryPair([ponsAi, ponsWeth], PONS);
    expect(primary?.quoteToken?.symbol).toBe("WETH");
  });
});
