import { describe, expect, it } from "vitest";

import {
  V2_ROUTERS,
  nativeProceeds,
  preflightV2Buy,
  tokensReceived,
} from "../src/chains/evm/v2-swap.js";

/**
 * Guard the wrapped-native addresses — a wrong one makes every getAmountsOut
 * (path = [wrappedNative, token]) revert, silently breaking all live trading.
 * A wrong BSC WBNB (…F60aF814…Ee75) shipped undetected until on-chain
 * simulation caught it; these are the canonical, on-chain-verified values.
 */
describe("preflightV2Buy", () => {
  it("fails closed (no network) for a chain without a v2 router", async () => {
    const r = await preflightV2Buy(
      "robinhood" as never,
      "0x0000000000000000000000000000000000000001",
      50,
      100,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("no v2 router");
    expect(r.quotedOut).toBe(0n);
  });
});

describe("V2_ROUTERS wrapped-native addresses", () => {
  it("uses the canonical wrapped-native per chain", () => {
    expect(V2_ROUTERS.bsc?.wrappedNative).toBe(
      "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    ); // WBNB
    expect(V2_ROUTERS.base?.wrappedNative).toBe(
      "0x4200000000000000000000000000000000000006",
    ); // WETH (Base)
    expect(V2_ROUTERS.ethereum?.wrappedNative).toBe(
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    ); // WETH
  });

  it("carries on-chain-verified multi-hop base intermediaries", () => {
    // USDT/BTCB on BSC — the hops that recover four.meme graduates lacking a
    // direct WBNB pair (e.g. GOLD/USDT). Verified via symbol() on-chain.
    expect(V2_ROUTERS.bsc?.bases).toEqual([
      "0x55d398326f99059fF775485246999027B3197955", // USDT
      "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", // BTCB
    ]);
    expect(V2_ROUTERS.base?.bases).toEqual([
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
    ]);
    expect(V2_ROUTERS.ethereum?.bases).toEqual([
      "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
    ]);
  });
});

describe("tokensReceived", () => {
  it("returns the balance delta on a normal fill", () => {
    expect(tokensReceived(1_000n, 3_500n)).toBe(2_500n);
  });

  it("captures the taxed amount (received < quoted) via the real delta", () => {
    // fee-on-transfer token: quote said 1000, only 920 actually landed
    expect(tokensReceived(0n, 920n)).toBe(920n);
  });

  it("never goes negative if the balance somehow drops", () => {
    expect(tokensReceived(500n, 400n)).toBe(0n);
  });
});

describe("nativeProceeds", () => {
  it("adds gas back to the net balance delta", () => {
    // before 10, after 14, gas 1 → gross proceeds 5
    expect(nativeProceeds(10n, 14n, 1n)).toBe(5n);
  });

  it("returns the full swap output when the wallet started empty", () => {
    expect(nativeProceeds(0n, 99n, 3n)).toBe(102n);
  });

  it("clamps to zero rather than reporting negative proceeds", () => {
    expect(nativeProceeds(100n, 10n, 5n)).toBe(0n);
  });
});
