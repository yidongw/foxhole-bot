import { describe, expect, it } from "vitest";

import { V2_ROUTERS, nativeProceeds, tokensReceived } from "../src/chains/evm/v2-swap.js";

/**
 * Guard the wrapped-native addresses — a wrong one makes every getAmountsOut
 * (path = [wrappedNative, token]) revert, silently breaking all live trading.
 * A wrong BSC WBNB (…F60aF814…Ee75) shipped undetected until on-chain
 * simulation caught it; these are the canonical, on-chain-verified values.
 */
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
