import { describe, expect, it } from "vitest";

import { isStockQuote } from "../src/lib/utils.js";

describe("isStockQuote", () => {
  it("accepts known stock symbols", () => {
    expect(isStockQuote("NVDA")).toBe(true);
    expect(isStockQuote("HIMS")).toBe(true);
  });

  it("rejects stables and gas tokens", () => {
    for (const s of ["ETH", "WETH", "USDG", "USDC", "USDT"]) {
      expect(isStockQuote(s)).toBe(false);
    }
  });

  it("accepts unknown short all-caps tickers, rejects the rest", () => {
    expect(isStockQuote("TTWO")).toBe(true);
    expect(isStockQuote("boner")).toBe(false);
    expect(isStockQuote("TOOLONGSYM")).toBe(false);
    expect(isStockQuote(undefined)).toBe(false);
  });
});
