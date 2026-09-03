import { describe, expect, it } from "vitest";

import { priceImpactVeto } from "../src/chains/solana/jupiter.js";

describe("priceImpactVeto", () => {
  it("vetoes swaps above the cap", () => {
    expect(priceImpactVeto("0.42", 0.15)).toMatch(/price impact 42\.0% > 15% cap/);
    expect(priceImpactVeto(0.2, 0.15)).toBeDefined();
  });

  it("allows swaps at or below the cap", () => {
    expect(priceImpactVeto("0.10", 0.15)).toBeUndefined();
    expect(priceImpactVeto(0.15, 0.15)).toBeUndefined();
    expect(priceImpactVeto("0", 0.15)).toBeUndefined();
  });

  it("fails open on missing / non-numeric impact (Jupiter omits the field)", () => {
    expect(priceImpactVeto(undefined, 0.15)).toBeUndefined();
    expect(priceImpactVeto("", 0.15)).toBeUndefined();
    expect(priceImpactVeto("NaN", 0.15)).toBeUndefined();
  });
});
