import { describe, expect, it } from "vitest";

import { replayCandles, type TokenBacktestFixture } from "../src/backtest/historical-replay.js";
import { SIGNAL_CONFIG } from "../src/signals/config.js";
import type { OhlcvCandle } from "../src/dex/dexpaprika.js";

function fixture(kind: "pump" | "control"): TokenBacktestFixture {
  return {
    kind,
    symbol: "TEST",
    address: "0xAbC0000000000000000000000000000000000001",
    poolId: "0xpool",
    quoteSymbol: "HIMS",
    launchAt: "2026-08-01T00:00:00.000Z",
    ohlcvStart: "2026-08-01",
  };
}

function candle(day: number, close: number, volume: number): OhlcvCandle {
  const date = new Date(Date.UTC(2026, 7, day));
  return {
    time_open: date.toISOString(),
    time_close: new Date(date.getTime() + 86_400_000).toISOString(),
    open: close,
    high: close,
    low: close,
    close,
    volume,
  };
}

describe("replayCandles", () => {
  it("alerts before the peak on a synthetic pump", () => {
    const candles = [
      candle(1, 1.0, 50_000),
      candle(2, 1.0, 60_000),
      candle(3, 1.05, 55_000),
      // day 4: volume accelerates 5x + price jumps — should alert here
      candle(4, 1.6, 300_000),
      // day 5: blow-off peak
      candle(5, 3.2, 2_000_000),
      candle(6, 2.0, 400_000),
    ];
    const r = replayCandles(fixture("pump"), candles);
    expect(r.passed).toBe(true);
    expect(r.peakDate).toBe("2026-08-05");
    expect(r.firstAlertDate).toBe("2026-08-04");
  });

  it("fails a pump that only alerts after the peak", () => {
    const candles = [
      // instant peak on day 1 — no prior candle and volume below the
      // $1M high_volume rule, so nothing can alert on it
      candle(1, 3.0, 900_000),
      candle(2, 1.2, 60_000),
      candle(3, 1.1, 55_000),
      candle(4, 1.5, 800_000), // late spike, after the peak
    ];
    const r = replayCandles(fixture("pump"), candles);
    expect(r.passed).toBe(false);
  });

  it("passes a flat control without alerts", () => {
    const candles = Array.from({ length: 20 }, (_, i) =>
      candle(i + 1, 1 + (i % 3) * 0.01, 40_000 + (i % 5) * 2_000),
    );
    const r = replayCandles(fixture("control"), candles);
    expect(r.passed).toBe(true);
    expect(r.alerts).toHaveLength(0);
  });

  it("fails a control that triggers an alert", () => {
    const candles = [
      candle(1, 1.0, 50_000),
      candle(2, 1.0, 50_000),
      candle(3, 1.0, 50_000),
      candle(4, 1.9, 600_000), // control shouldn't do this
      candle(5, 1.0, 50_000),
    ];
    const r = replayCandles(fixture("control"), candles);
    expect(r.passed).toBe(false);
    expect(r.failureReason).toMatch(/false positive/);
  });

  it("respects config overrides", () => {
    const candles = [
      candle(1, 1.0, 120_000),
      candle(2, 1.28, 130_000), // +28% day
      candle(3, 1.3, 125_000),
    ];
    const strict = replayCandles(fixture("control"), candles, {
      config: { ...SIGNAL_CONFIG, priceMomentumAlert: 25 },
    });
    expect(strict.passed).toBe(false); // 28% ≥ 25 alerts

    const loose = replayCandles(fixture("control"), candles, {
      config: { ...SIGNAL_CONFIG, priceMomentumAlert: 30 },
    });
    expect(loose.passed).toBe(true);
  });
});
