import { describe, expect, it } from "vitest";

import type { TradeConfig } from "../src/trade/config.js";
import {
  recordExit,
  remainingFraction,
  totalPnlUsd,
  type Position,
  type PositionsFile,
} from "../src/trade/positions.js";
import { checkEntry } from "../src/trade/risk.js";
import { evaluateExits } from "../src/trade/exits.js";

const CONFIG: TradeConfig = {
  mode: "paper",
  usdPerTrade: 50,
  maxDailySpendUsd: 200,
  maxOpenPositions: 3,
  minEntryLiquidityUsd: 50_000,
  slippageBps: 100,
  trailStopPct: 0.25,
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
