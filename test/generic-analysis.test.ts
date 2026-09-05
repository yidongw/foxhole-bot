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

describe("trustedOwnLiquidityUsd (transitive quote trust)", () => {
  const Q = "0x205812cdbed920aff76c6580b34a4325bfbb15aa";
  const p = (base: string, quote: string, liq: number): DexPair => ({
    baseToken: { address: base, symbol: "Q" },
    quoteToken: { symbol: quote },
    liquidity: { usd: liq },
  });

  it("real QQQB passes the $1M bar on trusted-quoted own pools", async () => {
    const { trustedOwnLiquidityUsd, CREDIBLE_QUOTE_MIN_TRUSTED_LIQ_USD } = await import(
      "../src/dex/quote-verify.js"
    );
    const pairs = [p(Q, "USDT", 2_000_000), p(Q, "WBNB", 1_167_000)];
    expect(trustedOwnLiquidityUsd(pairs, Q)).toBeGreaterThanOrEqual(
      CREDIBLE_QUOTE_MIN_TRUSTED_LIQ_USD,
    );
  });

  it("GMEB-style attack quote ($418k) stays below the bar", async () => {
    const { trustedOwnLiquidityUsd, CREDIBLE_QUOTE_MIN_TRUSTED_LIQ_USD } = await import(
      "../src/dex/quote-verify.js"
    );
    const pairs = [p(Q, "USDT", 418_054)];
    expect(trustedOwnLiquidityUsd(pairs, Q)).toBeLessThan(
      CREDIBLE_QUOTE_MIN_TRUSTED_LIQ_USD,
    );
  });

  it("ignores pools where the quote token is only the QUOTE side or untrusted-quoted", async () => {
    const { trustedOwnLiquidityUsd } = await import("../src/dex/quote-verify.js");
    const pairs = [
      p("0x000000000000000000000000000000000000dead", "USDT", 9_000_000), // other base
      p(Q, "JUNK", 9_000_000), // untrusted quote doesn't count
    ];
    expect(trustedOwnLiquidityUsd(pairs, Q)).toBe(0);
  });
});
