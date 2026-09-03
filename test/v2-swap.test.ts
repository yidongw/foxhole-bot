import { describe, expect, it } from "vitest";

import { nativeProceeds, tokensReceived } from "../src/chains/evm/v2-swap.js";

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
