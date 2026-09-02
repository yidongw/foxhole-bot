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
