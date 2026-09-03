import { afterEach, describe, expect, it } from "vitest";

import { priceImpactVeto, priorityFeeConfig } from "../src/chains/solana/jupiter.js";

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

describe("priorityFeeConfig", () => {
  const saved = {
    level: process.env.JUPITER_PRIORITY_LEVEL,
    max: process.env.JUPITER_PRIORITY_FEE_MAX_LAMPORTS,
  };
  afterEach(() => {
    process.env.JUPITER_PRIORITY_LEVEL = saved.level;
    process.env.JUPITER_PRIORITY_FEE_MAX_LAMPORTS = saved.max;
  });

  it("defaults to high with a 0.001 SOL cap", () => {
    delete process.env.JUPITER_PRIORITY_LEVEL;
    delete process.env.JUPITER_PRIORITY_FEE_MAX_LAMPORTS;
    expect(priorityFeeConfig()).toEqual({ level: "high", maxLamports: 1_000_000 });
  });

  it("honors valid env overrides", () => {
    process.env.JUPITER_PRIORITY_LEVEL = "veryHigh";
    process.env.JUPITER_PRIORITY_FEE_MAX_LAMPORTS = "500000";
    expect(priorityFeeConfig()).toEqual({ level: "veryHigh", maxLamports: 500_000 });
  });

  it("falls back to high on an invalid level", () => {
    process.env.JUPITER_PRIORITY_LEVEL = "insane";
    expect(priorityFeeConfig().level).toBe("high");
  });
});
