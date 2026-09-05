import { describe, expect, it, vi, beforeEach } from "vitest";

// The ledger stores the *quoted* fill size, so it drifts above the wallet's
// real balance; selling more than we hold reverts with STF and silently blocks
// every live exit. sell() must clamp to the on-chain balance.
const balances = { value: 0n };
const sold: number[] = [];

vi.mock("../src/chain/client.js", () => ({
  getErc20Balance: async () => balances.value,
  getTradingClient: () => ({ account: { address: "0xholder" } }),
}));
vi.mock("hoodchain", () => ({
  executeSwap: async (_c: unknown, p: { amountIn: bigint }) => {
    sold.push(Number(p.amountIn) / 1e18);
    return { hash: "0xhash", quote: { amountOut: 1_000_000n } };
  },
  MAINNET_ADDRESSES: { usdg: "0xusdg" },
  parseUsdg: (v: string) => BigInt(Math.round(Number(v) * 1e6)),
}));
vi.mock("../src/venues/okx/swap.js", () => ({ okxSwap: vi.fn() }));
vi.mock("../src/venues/lifi/swap.js", () => ({ lifiSwap: vi.fn() }));

const { sell } = await import("../src/trade/execute.js");

const config = { mode: "live", router: "hoodchain", slippageBps: 100 } as never;
const position = {
  token: "0xtoken",
  symbol: "ROBINCAT",
  amountTokens: 830.3356882615315,
} as never;

describe("live sell clamps to wallet balance", () => {
  beforeEach(() => {
    sold.length = 0;
  });

  it("sells the balance, not the larger ledger amount", async () => {
    balances.value = 830248817742480127681n; // real ROBINCAT balance
    await sell(config, position, 1, 0.008);
    expect(sold[0]).toBeLessThanOrEqual(830.248817742480127681);
    expect(sold[0]).toBeGreaterThan(829);
  });

  it("leaves the ledger amount alone when the wallet holds more", async () => {
    balances.value = 900n * 10n ** 18n;
    await sell(config, position, 1, 0.008);
    expect(sold[0]).toBeCloseTo(830.3356882615315, 6);
  });

  it("clamps partial sells too", async () => {
    balances.value = 400n * 10n ** 18n;
    await sell(config, position, 0.5, 0.008);
    expect(sold[0]).toBeLessThanOrEqual(400);
    expect(sold[0]).toBeGreaterThan(399);
  });

  it("does not touch paper fills", async () => {
    balances.value = 1n;
    const fill = await sell(
      { ...(config as object), mode: "paper" } as never,
      position,
      1,
      0.008,
    );
    expect(fill.amountTokens).toBeCloseTo(830.3356882615315, 6);
    expect(sold).toHaveLength(0);
  });
});
