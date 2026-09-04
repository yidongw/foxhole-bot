import { describe, expect, it } from "vitest";

import { selectDeepestBasePair } from "../src/chains/generic-analysis.js";
import type { DexPair } from "../src/types.js";

const TOKEN = "0xFe189E97832DA1573e4e4Ff034F4fFC3a15c7777";

function pair(
  priceUsd: string,
  liqUsd: number,
  quoteSymbol: string,
  base = TOKEN,
): DexPair {
  return {
    baseToken: { address: base, symbol: "MarsCoin" },
    quoteToken: { symbol: quoteSymbol },
    priceUsd,
    liquidity: { usd: liqUsd },
  };
}

describe("selectDeepestBasePair price consensus", () => {
  it("rejects a fake-liquidity pool whose price is 1000x off the other pools (MarsCoin 2026-09-04)", () => {
    const junk = pair("149.29", 1_847_612, "USDT"); // fake USDT quote, deepest by claimed liq
    const real1 = pair("0.1224", 900_000, "WBNB");
    const real2 = pair("0.1230", 600_000, "USDT");
    const picked = selectDeepestBasePair([junk, real1, real2], TOKEN);
    expect(picked?.priceUsd).toBe("0.1224");
  });

  it("keeps the deepest pool when all pools agree on price", () => {
    const a = pair("0.12", 1_000_000, "USDT");
    const b = pair("0.13", 500_000, "WBNB");
    expect(selectDeepestBasePair([a, b], TOKEN)?.liquidity?.usd).toBe(1_000_000);
  });

  it("with two conflicting pools, the lower-middle median rejects the fake-high one", () => {
    const junk = pair("100", 2_000_000, "USDT");
    const real = pair("0.10", 800_000, "USDT");
    expect(selectDeepestBasePair([junk, real], TOKEN)?.priceUsd).toBe("0.10");
  });

  it("single pool is returned as-is (no consensus available)", () => {
    const only = pair("0.5", 50_000, "USDT");
    expect(selectDeepestBasePair([only], TOKEN)).toBe(only);
  });

  it("still prefers trusted quotes and excludes quote-side pairs", () => {
    const quoteSide: DexPair = {
      baseToken: { address: "0x000000000000000000000000000000000000dEaD", symbol: "OTHER" },
      quoteToken: { symbol: "MarsCoin" },
      priceUsd: "999",
      liquidity: { usd: 9_000_000 },
    };
    const real = pair("0.12", 100_000, "USDT");
    expect(selectDeepestBasePair([quoteSide, real], TOKEN)?.priceUsd).toBe("0.12");
  });

  it("legit 2.5x price spread across pools is tolerated (within 3x band)", () => {
    const a = pair("0.10", 400_000, "USDT");
    const b = pair("0.24", 900_000, "WBNB"); // 2.4x off — real cross-pool skew, keep deepest
    expect(selectDeepestBasePair([a, b], TOKEN)?.priceUsd).toBe("0.24");
  });
});
