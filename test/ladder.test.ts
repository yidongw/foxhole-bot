import { describe, expect, it } from "vitest";

import { detectLadderPump, ladderMetrics } from "../src/signals/ladder.js";
import type { OhlcvCandle } from "../src/dex/dexpaprika.js";

function candles(closes: number[], volume = 2_000): OhlcvCandle[] {
  return closes.map((close, i) => ({
    time_open: new Date(Date.UTC(2026, 8, 1, i)).toISOString(),
    time_close: new Date(Date.UTC(2026, 8, 1, i + 1)).toISOString(),
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume,
  }));
}

describe("detectLadderPump", () => {
  it("flags a long perfect staircase (AVANT pattern)", () => {
    // 22 hours, every candle up ~8%, zero pullback
    const closes = Array.from({ length: 22 }, (_, i) => 1 * 1.08 ** i);
    const v = detectLadderPump(candles(closes));
    expect(v.isLadder).toBe(true);
    expect(v.metrics!.straightness).toBeLessThan(1.05);
    expect(v.metrics!.greenRatio).toBe(1);
  });

  it("passes an organic pump with retraces", () => {
    // net +150% but with real pullbacks along the way
    const closes = [1, 1.3, 1.1, 1.6, 1.35, 1.9, 1.5, 2.2, 1.8, 2.5, 2.1, 2.6];
    const v = detectLadderPump(candles(closes));
    expect(v.isLadder).toBe(false);
  });

  it("ignores short straight bursts (Pumpooor pattern)", () => {
    const closes = [1, 1.3, 1.6, 1.78]; // 4 candles straight up — normal burst
    expect(detectLadderPump(candles(closes)).isLadder).toBe(false);
  });

  it("ignores flat charts", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 1 + (i % 3) * 0.01);
    expect(detectLadderPump(candles(closes)).isLadder).toBe(false);
  });

  it("computes straightness ≈ path/net", () => {
    const m = ladderMetrics([1, 2, 1.5, 2.5], [1, 1, 1, 1]);
    // path = 1 + 0.5 + 1 = 2.5, net = 1.5
    expect(m.straightness).toBeCloseTo(2.5 / 1.5);
  });
});
