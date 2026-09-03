import { describe, expect, it } from "vitest";

import { evaluateSignal } from "../src/signals/evaluate.js";
import { SIGNAL_CONFIG } from "../src/signals/config.js";
import type { SignalInput } from "../src/signals/types.js";

function baseInput(overrides: Partial<SignalInput> = {}): SignalInput {
  return {
    address: "0x98096d17e191b3da1d5f99a6d7b3584351b11e18",
    symbol: "BONER",
    primaryPair: "BONER/HIMS",
    quoteSymbol: "HIMS",
    isStockPaired: true,
    volume24hUsd: 500_000,
    liquidityUsd: 1_000_000,
    ...overrides,
  };
}

describe("evaluateSignal", () => {
  it("returns none below the liquidity floor", () => {
    const ev = evaluateSignal(
      baseInput({ liquidityUsd: SIGNAL_CONFIG.minLiquidityUsd - 1 }),
    );
    expect(ev.level).toBe("none");
    expect(ev.reasons).toContain("liquidity too low");
  });

  it("scores lock tiers: watch < alert < strong", () => {
    const watch = evaluateSignal(baseInput({ quoteLockRatio: SIGNAL_CONFIG.lockWatch }));
    const alert = evaluateSignal(baseInput({ quoteLockRatio: SIGNAL_CONFIG.lockAlert }));
    const strong = evaluateSignal(baseInput({ quoteLockRatio: SIGNAL_CONFIG.lockStrong }));
    expect(watch.triggers).toContain("lock_watch");
    expect(alert.triggers).toContain("lock_alert");
    expect(strong.triggers).toContain("lock_strong");
    expect(strong.score).toBeGreaterThan(alert.score);
    expect(alert.score).toBeGreaterThan(watch.score);
  });

  it("ignores lock on non-stock pairs", () => {
    const ev = evaluateSignal(
      baseInput({ isStockPaired: false, quoteSymbol: "WETH", quoteLockRatio: 0.6 }),
    );
    expect(ev.triggers).not.toContain("lock_strong");
  });

  it("fires lock_rising only when lock is climbing and above the watch floor", () => {
    const rising = evaluateSignal(
      baseInput({
        quoteLockRatio: SIGNAL_CONFIG.lockWatch,
        quoteLockDelta: SIGNAL_CONFIG.lockRiseAlert,
      }),
    );
    expect(rising.triggers).toContain("lock_rising");

    const risingStrong = evaluateSignal(
      baseInput({
        quoteLockRatio: SIGNAL_CONFIG.lockWatch,
        quoteLockDelta: SIGNAL_CONFIG.lockRiseStrong,
      }),
    );
    expect(risingStrong.triggers).toContain("lock_rising_strong");
    expect(risingStrong.level).toBe("strong");

    const belowFloor = evaluateSignal(
      baseInput({ quoteLockRatio: 0.05, quoteLockDelta: 0.2 }),
    );
    expect(belowFloor.triggers).not.toContain("lock_rising");

    const falling = evaluateSignal(
      baseInput({ quoteLockRatio: 0.4, quoteLockDelta: -0.05 }),
    );
    expect(falling.triggers).not.toContain("lock_rising");
  });

  it("requires min volume for volume spike triggers", () => {
    const quiet = evaluateSignal(
      baseInput({
        volume24hUsd: SIGNAL_CONFIG.minVolumeUsd - 1,
        volumeSpikeRatio: SIGNAL_CONFIG.volumeSpikeStrong,
      }),
    );
    expect(quiet.triggers).not.toContain("volume_spike_strong");

    const loud = evaluateSignal(
      baseInput({
        volume24hUsd: SIGNAL_CONFIG.minVolumeUsd,
        volumeSpikeRatio: SIGNAL_CONFIG.volumeSpikeStrong,
      }),
    );
    expect(loud.triggers).toContain("volume_spike_strong");
    expect(loud.level).toBe("strong");
  });

  it("fires the BONER composite when lock + volume + spike align", () => {
    const ev = evaluateSignal(
      baseInput({
        quoteLockRatio: SIGNAL_CONFIG.lockAlert,
        volume24hUsd: 500_000,
        volumeSpikeRatio: 3,
      }),
    );
    expect(ev.triggers).toContain("boner_composite");
    expect(ev.level).toBe("strong");
  });

  it("flags new stock-paired launches inside the watch window", () => {
    const ev = evaluateSignal(
      baseInput({
        daysSinceLaunch: SIGNAL_CONFIG.launchWatchDays - 1,
        volume24hUsd: SIGNAL_CONFIG.minVolumeUsd * 0.5,
      }),
    );
    expect(ev.triggers).toContain("launch_watch");
  });
});

describe("post-pump demotion (DIDDY lesson)", () => {
  it("caps strong signals to alert once the 24h move already happened", () => {
    const ev = evaluateSignal(
      baseInput({
        quoteLockRatio: SIGNAL_CONFIG.lockStrong,
        priceChange24h: 3136, // DIDDY at signal time
        volumeSpikeRatio: SIGNAL_CONFIG.volumeSpikeStrong,
      }),
    );
    expect(ev.level).toBe("alert");
    expect(ev.triggers).toContain("post_pump");
  });

  it("leaves genuinely early movers untouched", () => {
    const ev = evaluateSignal(
      baseInput({
        quoteLockRatio: SIGNAL_CONFIG.lockStrong,
        priceChange24h: 32, // LIGMA at signal time — real early entry
      }),
    );
    expect(ev.level).toBe("strong");
    expect(ev.triggers).not.toContain("post_pump");
  });
});

describe("falling-knife demotion (BONER 2026-09-03 lesson)", () => {
  it("caps volume-driven strong signals to alert when price is dropping", () => {
    const ev = evaluateSignal(
      baseInput({
        quoteLockRatio: SIGNAL_CONFIG.lockStrong,
        volumeSpikeRatio: SIGNAL_CONFIG.volumeSpikeStrong,
        priceChange24h: -24, // BONER: sell-off volume read as acceleration
      }),
    );
    expect(ev.level).toBe("alert");
    expect(ev.triggers).toContain("falling_knife");
  });

  it("tolerates shallow dips", () => {
    const ev = evaluateSignal(
      baseInput({
        quoteLockRatio: SIGNAL_CONFIG.lockStrong,
        priceChange24h: -5,
      }),
    );
    expect(ev.level).toBe("strong");
    expect(ev.triggers).not.toContain("falling_knife");
  });
});
