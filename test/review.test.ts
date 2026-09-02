import { describe, expect, it } from "vitest";

import { gradeFromCandles } from "../src/review/ledger.js";
import { classifyMover, type Mover } from "../src/review/movers.js";
import { replayHourlyCase } from "../src/review/cases.js";
import { generateCandidates, scoreCases } from "../src/review/tuner.js";
import { SIGNAL_CONFIG } from "../src/signals/config.js";
import type { OhlcvCandle } from "../src/dex/dexpaprika.js";
import type { MonitorState } from "../src/monitor/state.js";

function hourly(hoursAgoStart: number, spec: Array<{ close: number; volume: number }>): OhlcvCandle[] {
  const startMs = Date.now() - hoursAgoStart * 3_600_000;
  return spec.map((s, i) => ({
    time_open: new Date(startMs + i * 3_600_000).toISOString(),
    time_close: new Date(startMs + (i + 1) * 3_600_000).toISOString(),
    open: s.close,
    high: s.close * 1.02,
    low: s.close * 0.98,
    close: s.close,
    volume: s.volume,
  }));
}

describe("gradeFromCandles", () => {
  const at = new Date(Date.now() - 30 * 3_600_000).toISOString();

  it("grades a +40% peak as win even after a fade", () => {
    const candles = hourly(28, [
      { close: 1.2, volume: 1000 },
      { close: 1.5, volume: 5000 }, // high ≈ 1.53 → +53%
      { close: 0.9, volume: 2000 },
    ]);
    const g = gradeFromCandles({ priceUsd: 1, at }, candles);
    expect(g.outcome).toBe("win");
    expect(g.maxReturn).toBeGreaterThan(0.4);
  });

  it("grades a -30% drop without a prior win as loss", () => {
    const candles = hourly(28, [
      { close: 0.9, volume: 1000 },
      { close: 0.6, volume: 1000 },
    ]);
    expect(gradeFromCandles({ priceUsd: 1, at }, candles).outcome).toBe("loss");
  });

  it("grades sideways as flat", () => {
    const candles = hourly(28, [
      { close: 1.1, volume: 1000 },
      { close: 0.95, volume: 1000 },
    ]);
    expect(gradeFromCandles({ priceUsd: 1, at }, candles).outcome).toBe("flat");
  });

  it("grades a dead pool (no candles) as loss", () => {
    expect(gradeFromCandles({ priceUsd: 1, at }, []).outcome).toBe("loss");
  });

  it("ignores candles from before the alert", () => {
    const before = hourly(60, [{ close: 5, volume: 1000 }]); // pre-alert spike
    const after = hourly(20, [{ close: 1.0, volume: 1000 }]);
    const g = gradeFromCandles({ priceUsd: 1, at }, [...before, ...after]);
    expect(g.outcome).toBe("flat");
  });
});

describe("classifyMover", () => {
  const mover: Mover = {
    chain: "bsc",
    poolId: "0xpool",
    address: "0xToKen",
    symbol: "X",
    priceChange24h: 250,
    volume24hUsd: 500_000,
    liquidityUsd: 80_000,
  };
  const emptyState: MonitorState = { version: 1, tokens: {}, alertHistory: {} };

  it("credits alerted movers", () => {
    const ledger = [{ chain: "bsc", address: "0xtoken", at: new Date().toISOString() }];
    expect(classifyMover(mover, emptyState, ledger)).toBe("alerted");
  });

  it("stale ledger entries do not count", () => {
    const ledger = [
      { chain: "bsc", address: "0xtoken", at: new Date(Date.now() - 5 * 86_400_000).toISOString() },
    ];
    expect(classifyMover(mover, emptyState, ledger)).toBe("coverage_miss");
  });

  it("scanned-but-silent is a threshold miss", () => {
    const state: MonitorState = {
      version: 1,
      alertHistory: {},
      tokens: {
        "bsc:0xtoken": { volume24hUsd: 1, level: "watch", score: 5, updatedAt: new Date().toISOString() },
      },
    };
    expect(classifyMover(mover, state, [])).toBe("threshold_miss");
  });
});

describe("replayHourlyCase", () => {
  function makeCase(kind: "pump" | "control", candles: OhlcvCandle[]) {
    return {
      kind,
      chain: "bsc",
      address: "0x1",
      symbol: "T",
      liquidityUsd: 200_000,
      candles,
    };
  }

  it("alerts before the peak on an hourly pump", () => {
    // 30h quiet, then volume+price ramp into a peak
    const quiet = Array.from({ length: 30 }, () => ({ close: 1, volume: 3_000 }));
    const ramp = [
      { close: 1.3, volume: 120_000 }, // rolling24 jumps, momentum +30%
      { close: 1.8, volume: 200_000 },
      { close: 3.0, volume: 400_000 }, // peak
      { close: 2.0, volume: 100_000 },
    ];
    const r = replayHourlyCase(makeCase("pump", hourly(40, [...quiet, ...ramp])), SIGNAL_CONFIG);
    expect(r.passed).toBe(true);
    expect(r.firstAlertAt! <= r.peakAt).toBe(true);
  });

  it("stays silent on a quiet control", () => {
    const quiet = Array.from({ length: 48 }, (_, i) => ({
      close: 1 + (i % 5) * 0.005,
      volume: 2_000 + (i % 7) * 100,
    }));
    const r = replayHourlyCase(makeCase("control", hourly(50, quiet)), SIGNAL_CONFIG);
    expect(r.passed).toBe(true);
    expect(r.alertHours).toBe(0);
  });
});

describe("tuner candidates + scoring", () => {
  it("generates one- and two-param neighbors only", () => {
    const candidates = generateCandidates(SIGNAL_CONFIG);
    expect(candidates.length).toBeGreaterThan(10);
    for (const c of candidates) {
      const n = Object.keys(c.changes).length;
      expect(n === 1 || n === 2).toBe(true);
    }
  });

  it("scores wins/misses/false alerts against a config", () => {
    const quiet = Array.from({ length: 30 }, () => ({ close: 1, volume: 3_000 }));
    const pumpCandles = hourly(40, [
      ...quiet,
      { close: 1.3, volume: 120_000 },
      { close: 2.5, volume: 300_000 },
    ]);
    const flatCandles = hourly(40, Array.from({ length: 40 }, () => ({ close: 1, volume: 2_000 })));
    const base = { chain: "bsc", address: "0x1", poolId: "p", anchorAt: "", liquidityUsd: 200_000 };
    const cases = [
      { ...base, kind: "pump" as const, source: "win" as const, candles: pumpCandles },
      { ...base, kind: "pump" as const, source: "missed" as const, candles: pumpCandles },
      { ...base, kind: "control" as const, source: "loss" as const, candles: flatCandles },
    ];
    const s = scoreCases(cases, SIGNAL_CONFIG);
    expect(s.winsCaptured).toBe(1);
    expect(s.missesCaptured).toBe(1);
    expect(s.falseAlerts).toBe(0); // quiet control doesn't alert
    expect(s.net).toBe(2);
  });
});
