import type { OhlcvCandle } from "../dex/dexpaprika.js";

/**
 * Ladder-pump (刷单画线) detector.
 *
 * Wash bots buying in small uniform increments paint an hours-long,
 * near-perfect staircase: almost every candle green, essentially zero
 * pullback, price path length ≈ net move. Organic pumps retrace.
 *
 * Calibrated on live data (2026-09-02): AVANT ladder = 22h, +439%,
 * straightness 1.00, 100% green, 0.0% drawdown, volume CV 0.11.
 * Short organic bursts (e.g. 3 candles) are excluded by MIN_CANDLES —
 * only sustained perfection is mechanical.
 */

export const LADDER_MIN_CANDLES = 10;
export const LADDER_MIN_GAIN = 0.5;
export const LADDER_MAX_STRAIGHTNESS = 1.25;
export const LADDER_MIN_GREEN_RATIO = 0.85;
export const LADDER_MAX_DRAWDOWN = 0.08;

export interface LadderMetrics {
  candles: number;
  gain: number;
  /** path length / net move — 1.0 is a perfect line, organic ≫ 1. */
  straightness: number;
  greenRatio: number;
  maxDrawdown: number;
  volumeCV: number;
}

export interface LadderVerdict {
  isLadder: boolean;
  metrics?: LadderMetrics;
}

/** Metrics over one rising segment of closes/volumes. */
export function ladderMetrics(
  closes: number[],
  volumes: number[],
): LadderMetrics {
  const n = closes.length;
  const net = Math.abs(closes[n - 1] - closes[0]);
  let path = 0;
  let ups = 0;
  let peak = closes[0];
  let maxDrawdown = 0;
  for (let i = 1; i < n; i++) {
    path += Math.abs(closes[i] - closes[i - 1]);
    if (closes[i] > closes[i - 1]) ups++;
    peak = Math.max(peak, closes[i]);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - closes[i]) / peak);
  }
  const meanV = volumes.reduce((a, b) => a + b, 0) / n;
  const volumeCV = meanV
    ? Math.sqrt(volumes.reduce((a, b) => a + (b - meanV) ** 2, 0) / n) / meanV
    : 0;
  return {
    candles: n,
    gain: closes[0] > 0 ? closes[n - 1] / closes[0] - 1 : 0,
    straightness: net > 0 ? path / net : Infinity,
    greenRatio: n > 1 ? ups / (n - 1) : 0,
    maxDrawdown,
    volumeCV,
  };
}

/** Detect a ladder pump in a candle series (min-close → max-close segment). */
export function detectLadderPump(candles: OhlcvCandle[]): LadderVerdict {
  if (candles.length < LADDER_MIN_CANDLES) return { isLadder: false };
  const closes = candles.map((c) => c.close);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] < closes[lo]) lo = i;
    if (closes[i] > closes[hi]) hi = i;
  }
  if (hi - lo + 1 < LADDER_MIN_CANDLES) return { isLadder: false };

  const segment = candles.slice(lo, hi + 1);
  const m = ladderMetrics(
    segment.map((c) => c.close),
    segment.map((c) => c.volume),
  );
  const isLadder =
    m.gain >= LADDER_MIN_GAIN &&
    m.straightness <= LADDER_MAX_STRAIGHTNESS &&
    m.greenRatio >= LADDER_MIN_GREEN_RATIO &&
    m.maxDrawdown <= LADDER_MAX_DRAWDOWN;
  return { isLadder, metrics: m };
}
