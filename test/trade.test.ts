import { describe, expect, it } from "vitest";

import type { TradeConfig } from "../src/trade/config.js";
import {
  recordExit,
  remainingFraction,
  totalPnlUsd,
  type Position,
  type PositionsFile,
} from "../src/trade/positions.js";
import { processSignals } from "../src/trade/engine.js";
import { checkEntry } from "../src/trade/risk.js";
import { evaluateExits, effectiveExitParams } from "../src/trade/exits.js";
import {
  mergeStrategy,
  sanitizeStrategy,
  formatStrategy,
} from "../src/trade/positions.js";

const CONFIG: TradeConfig = {
  mode: "paper",
  usdPerTrade: 50,
  maxDailySpendUsd: 200,
  paperStartUsd: 1000,
  autoEntry: true,
  maxOpenPositions: 3,
  minEntryLiquidityUsd: 50_000,
  slippageBps: 100,
  trailStopPct: 0.25,
  trailArmMultiple: 1.5,
  hardStopPct: 0.35,
  takeProfits: [
    { atMultiple: 2, sellFraction: 0.5 },
    { atMultiple: 4, sellFraction: 0.25 },
  ],
  maxHoldHours: 96,
  entryTriggers: ["lock_strong", "lock_rising_strong", "boner_composite"],
  denylist: ["0xbad0000000000000000000000000000000000000"],
};

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: "test-1",
    mode: "paper",
    token: "0xAbC0000000000000000000000000000000000001",
    symbol: "TEST",
    trigger: "lock_strong",
    openedAt: new Date().toISOString(),
    entryPriceUsd: 1,
    amountTokens: 50,
    costUsd: 50,
    highWaterUsd: 1,
    exits: [],
    status: "open",
    ...overrides,
  };
}

function makeFile(positions: Position[] = []): PositionsFile {
  return { version: 1, positions };
}

const CANDIDATE = {
  token: "0xAbC0000000000000000000000000000000000001",
  symbol: "TEST",
  priceUsd: 1,
  liquidityUsd: 100_000,
  triggers: ["lock_strong"],
};

describe("checkEntry", () => {
  it("passes a clean candidate", () => {
    expect(checkEntry(CONFIG, makeFile(), CANDIDATE).ok).toBe(true);
  });

  it("rejects when trading is off", () => {
    expect(checkEntry({ ...CONFIG, mode: "off" }, makeFile(), CANDIDATE).ok).toBe(false);
  });

  it("rejects without a qualifying trigger", () => {
    const v = checkEntry(CONFIG, makeFile(), { ...CANDIDATE, triggers: ["momentum_alert"] });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/trigger/);
  });

  it("rejects denylisted tokens, thin liquidity, and missing price", () => {
    expect(
      checkEntry(CONFIG, makeFile(), { ...CANDIDATE, token: CONFIG.denylist[0] }).ok,
    ).toBe(false);
    expect(
      checkEntry(CONFIG, makeFile(), { ...CANDIDATE, liquidityUsd: 10_000 }).ok,
    ).toBe(false);
    expect(
      checkEntry(CONFIG, makeFile(), { ...CANDIDATE, priceUsd: undefined }).ok,
    ).toBe(false);
  });

  it("rejects duplicate and over-limit positions", () => {
    const dup = makeFile([makePosition()]);
    expect(checkEntry(CONFIG, dup, CANDIDATE).ok).toBe(false);

    const full = makeFile([
      makePosition({ id: "a", token: "0x1000000000000000000000000000000000000000" }),
      makePosition({ id: "b", token: "0x2000000000000000000000000000000000000000" }),
      makePosition({ id: "c", token: "0x3000000000000000000000000000000000000000" }),
    ]);
    expect(checkEntry(CONFIG, full, CANDIDATE).reason).toMatch(/max open/);

    // maxOpenPositions <= 0 = unlimited (user opt-out of the slot cap).
    expect(checkEntry({ ...CONFIG, maxOpenPositions: 0 }, full, CANDIDATE).ok).toBe(true);
  });

  it("enforces the daily spend cap", () => {
    const file = makeFile([
      makePosition({ id: "a", token: "0x1000000000000000000000000000000000000000", costUsd: 180 }),
    ]);
    const v = checkEntry(CONFIG, file, CANDIDATE);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/capital-at-risk/);
  });
});

describe("evaluateExits", () => {
  it("hard-stops the full remaining position", () => {
    const p = makePosition();
    const actions = evaluateExits(p, 0.64, CONFIG); // -36% < -35%
    expect(actions).toHaveLength(1);
    expect(actions[0].fraction).toBe(1);
    expect(actions[0].reason).toMatch(/hard stop/);
  });

  it("trail-stops from the high-water mark", () => {
    const p = makePosition({ highWaterUsd: 2 });
    const actions = evaluateExits(p, 1.4, CONFIG); // -30% off high, above hard stop
    expect(actions[0].reason).toMatch(/trail stop/);
  });

  it("does not trail-stop when never above entry", () => {
    const p = makePosition({ highWaterUsd: 1 });
    expect(evaluateExits(p, 0.8, CONFIG)).toHaveLength(0); // -20%: no stop yet
  });

  it("does not arm the trail below trailArmMultiple (NUDES #1 scratch-out)", () => {
    // High-water +21% (below 1.5x arm), then a routine wiggle to -25% off
    // that high (-9.3% under entry). The old `highWater > entry` arming
    // force-closed exactly this shape at a loss hours before the real move.
    const p = makePosition({ highWaterUsd: 1.21 });
    expect(evaluateExits(p, 0.9075, CONFIG)).toHaveLength(0);
    // Hard stop still guards the unarmed phase.
    expect(evaluateExits(p, 0.64, CONFIG)[0].reason).toMatch(/hard stop/);
    // Once high-water clears the arm threshold, the trail works as before.
    const armed = makePosition({ highWaterUsd: 1.6 });
    expect(evaluateExits(armed, 1.15, CONFIG)[0].reason).toMatch(/trail stop/);
  });

  it("takes tiered profits once each", () => {
    const p = makePosition();
    const first = evaluateExits(p, 2.1, CONFIG);
    expect(first).toHaveLength(1);
    expect(first[0].fraction).toBe(0.5);

    recordExit(p, {
      at: new Date().toISOString(),
      priceUsd: 2.1,
      fraction: 0.5,
      proceedsUsd: 52.5,
      reason: "tp x2: sell 50%",
    });
    // still above x2 but that tier is spent; x4 not reached
    expect(evaluateExits(p, 2.2, CONFIG)).toHaveLength(0);

    const second = evaluateExits(p, 4.5, CONFIG);
    expect(second).toHaveLength(1);
    expect(second[0].reason).toMatch(/x4/);
  });

  it("closes stale positions after maxHoldHours", () => {
    const p = makePosition({
      openedAt: new Date(Date.now() - 100 * 3_600_000).toISOString(),
    });
    const actions = evaluateExits(p, 1.0, CONFIG);
    expect(actions[0].reason).toMatch(/stale/);
  });
});

describe("per-position strategy", () => {
  it("falls back to config where the position has no strategy", () => {
    const rails = effectiveExitParams(makePosition(), CONFIG);
    expect(rails.hardStopPct).toBe(CONFIG.hardStopPct);
    expect(rails.takeProfits).toEqual(CONFIG.takeProfits);
    expect(rails.maxHoldHours).toBe(CONFIG.maxHoldHours);
  });

  it("overrides only the fields the strategy sets", () => {
    const p = makePosition({ strategy: { hardStopPct: 0.5, trailStopPct: 0.15 } });
    const rails = effectiveExitParams(p, CONFIG);
    expect(rails.hardStopPct).toBe(0.5); // overridden
    expect(rails.trailStopPct).toBe(0.15); // overridden
    expect(rails.trailArmMultiple).toBe(CONFIG.trailArmMultiple); // default
    expect(rails.maxHoldHours).toBe(CONFIG.maxHoldHours); // default
  });

  it("evaluateExits honors a wider per-position hard stop", () => {
    // -36% would hard-stop under the default 35%, but this position's plan
    // gives it room to -50% — a smart-money early launch that expects chop.
    const p = makePosition({ strategy: { hardStopPct: 0.5 } });
    expect(evaluateExits(p, 0.64, CONFIG)).toHaveLength(0);
    expect(evaluateExits(p, 0.49, CONFIG)[0].reason).toMatch(/hard stop: 50%/);
  });

  it("evaluateExits honors a tighter per-position hard stop", () => {
    // A noisy pure-momentum chase wants out fast: stop at -15%.
    const p = makePosition({ strategy: { hardStopPct: 0.15 } });
    expect(evaluateExits(p, 0.84, CONFIG)[0].reason).toMatch(/hard stop: 15%/);
  });

  it("evaluateExits honors a per-position take-profit ladder", () => {
    const p = makePosition({ strategy: { takeProfits: [{ atMultiple: 3, sellFraction: 0.6 }] } });
    // Default x2 tier is gone — nothing at 2.1x.
    expect(evaluateExits(p, 2.1, CONFIG)).toHaveLength(0);
    const at3 = evaluateExits(p, 3.1, CONFIG);
    expect(at3[0].fraction).toBe(0.6);
    expect(at3[0].reason).toMatch(/x3/);
  });

  it("evaluateExits honors a per-position max hold", () => {
    const p = makePosition({
      strategy: { maxHoldHours: 6 },
      openedAt: new Date(Date.now() - 8 * 3_600_000).toISOString(),
    });
    expect(evaluateExits(p, 1.0, CONFIG)[0].reason).toMatch(/stale/);
  });

  it("sanitizeStrategy drops out-of-range and junk fields", () => {
    const s = sanitizeStrategy({
      hardStopPct: 2, // >0.95 → dropped
      trailStopPct: 0.2, // ok
      trailArmMultiple: 0.5, // <1 → dropped
      maxHoldHours: -3, // ≤0 → dropped
      takeProfits: [
        { atMultiple: 0.5, sellFraction: 0.5 }, // multiple ≤1 → dropped
        { atMultiple: 4, sellFraction: 0.3 }, // ok
      ],
    });
    expect(s.hardStopPct).toBeUndefined();
    expect(s.trailStopPct).toBe(0.2);
    expect(s.trailArmMultiple).toBeUndefined();
    expect(s.maxHoldHours).toBeUndefined();
    expect(s.takeProfits).toEqual([{ atMultiple: 4, sellFraction: 0.3 }]);
  });

  it("mergeStrategy is field-wise and stamps updatedAt", () => {
    const p = makePosition();
    mergeStrategy(p, { hardStopPct: 0.4, note: "smart-money 早期,给空间" });
    expect(p.strategy?.hardStopPct).toBe(0.4);
    mergeStrategy(p, { trailStopPct: 0.3 });
    // first field survives the second merge
    expect(p.strategy?.hardStopPct).toBe(0.4);
    expect(p.strategy?.trailStopPct).toBe(0.3);
    expect(p.strategy?.note).toBe("smart-money 早期,给空间");
    expect(p.strategy?.updatedAt).toBeTruthy();
  });

  it("formatStrategy renders a readable summary and defaults", () => {
    expect(formatStrategy(undefined)).toBe("默认策略");
    const p = makePosition();
    mergeStrategy(p, { hardStopPct: 0.5, takeProfits: [{ atMultiple: 3, sellFraction: 0.5 }] });
    const line = formatStrategy(p.strategy);
    expect(line).toMatch(/硬止损 -50%/);
    expect(line).toMatch(/3x→50%/);
  });
});

describe("position math", () => {
  it("tracks remaining fraction and closes at zero", () => {
    const p = makePosition();
    recordExit(p, {
      at: new Date().toISOString(),
      priceUsd: 2,
      fraction: 0.5,
      proceedsUsd: 50,
      reason: "tp x2",
    });
    expect(remainingFraction(p)).toBeCloseTo(0.5);
    expect(p.status).toBe("open");

    recordExit(p, {
      at: new Date().toISOString(),
      priceUsd: 1.5,
      fraction: 0.5,
      proceedsUsd: 37.5,
      reason: "trail stop",
    });
    expect(p.status).toBe("closed");
    // realized 87.5 - cost 50 = +37.5
    expect(totalPnlUsd(p)).toBeCloseTo(37.5);
  });

  it("marks open positions to market", () => {
    const p = makePosition();
    // 50 tokens @ $1.4 = $70 vs $50 cost
    expect(totalPnlUsd(p, 1.4)).toBeCloseTo(20);
  });
});

describe("paperCashUsd + cap opt-out", () => {
  it("cash = start - costs + proceeds", async () => {
    const { paperCashUsd } = await import("../src/trade/positions.js");
    const file = makeFile([
      makePosition({ id: "a", token: "0x1000000000000000000000000000000000000000", costUsd: 50,
        status: "closed", exits: [{ at: new Date().toISOString(), fraction: 1, priceUsd: 1, proceedsUsd: 60 }] }),
      makePosition({ id: "b", token: "0x2000000000000000000000000000000000000000", costUsd: 45, exits: [] }),
    ]);
    // 1000 - 50 - 45 + 60 = 965
    expect(paperCashUsd(file, 1000)).toBeCloseTo(965, 2);
  });

  it("maxDailySpendUsd <= 0 disables the 24h cap", () => {
    const file = makeFile([
      makePosition({ id: "a", token: "0x1000000000000000000000000000000000000000", costUsd: 5000 }),
    ]);
    expect(checkEntry({ ...CONFIG, maxDailySpendUsd: 0 }, file, CANDIDATE).ok).toBe(true);
  });
});

describe("autoEntry gate", () => {
  it("processSignals opens nothing when autoEntry is off (AI decider owns entries)", async () => {
    const evals = [{
      input: { address: "0xTok", chain: "robinhood", symbol: "X", priceUsd: 1, liquidityUsd: 100_000 },
      triggers: ["lock_strong"], level: "strong", score: 100, reasons: [],
    }] as never;
    const opened = await processSignals(evals, { dryRun: true }, { ...CONFIG, mode: "paper", autoEntry: false });
    expect(opened).toHaveLength(0);
  });
});
