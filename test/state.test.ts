import { describe, expect, it } from "vitest";

import {
  isLevelUpgrade,
  pruneMonitorState,
  recordAlert,
  shouldSendAlert,
  type MonitorState,
} from "../src/monitor/state.js";
import { SIGNAL_CONFIG } from "../src/signals/config.js";

const ADDR = "0xAbC0000000000000000000000000000000000001";

function emptyState(): MonitorState {
  return { version: 1, tokens: {}, alertHistory: {} };
}

describe("shouldSendAlert / recordAlert", () => {
  it("never sends for level none", () => {
    expect(shouldSendAlert(emptyState(), ADDR, "none", [])).toBe(false);
  });

  it("sends the first alert, then suppresses within the cooldown", () => {
    const state = emptyState();
    expect(shouldSendAlert(state, ADDR, "alert", ["lock_alert"])).toBe(true);
    recordAlert(state, ADDR, "alert", ["lock_alert"]);
    expect(shouldSendAlert(state, ADDR, "alert", ["lock_alert"])).toBe(false);
  });

  it("keys on level + trigger set, order-insensitive", () => {
    const state = emptyState();
    recordAlert(state, ADDR, "alert", ["b", "a"]);
    expect(shouldSendAlert(state, ADDR, "alert", ["a", "b"])).toBe(false);
    // different trigger set → new alert
    expect(shouldSendAlert(state, ADDR, "alert", ["a"])).toBe(true);
    // different level → new alert
    expect(shouldSendAlert(state, ADDR, "strong", ["a", "b"])).toBe(true);
  });

  it("sends again after the cooldown elapses", () => {
    const state = emptyState();
    recordAlert(state, ADDR, "alert", ["x"]);
    const key = `${ADDR.toLowerCase()}:alert:x`;
    state.alertHistory[key] = new Date(
      Date.now() - SIGNAL_CONFIG.alertCooldownMs - 1000,
    ).toISOString();
    expect(shouldSendAlert(state, ADDR, "alert", ["x"])).toBe(true);
  });
});

describe("pruneMonitorState", () => {
  it("drops old alert history and token snapshots, keeps fresh ones", () => {
    const now = Date.now();
    const state = emptyState();
    state.alertHistory["old"] = new Date(now - 8 * 86_400_000).toISOString();
    state.alertHistory["fresh"] = new Date(now - 3_600_000).toISOString();
    state.tokens["0xdead"] = {
      volume24hUsd: 0,
      level: "none",
      score: 0,
      updatedAt: new Date(now - 31 * 86_400_000).toISOString(),
    };
    state.tokens["0xlive"] = {
      volume24hUsd: 1,
      level: "watch",
      score: 10,
      updatedAt: new Date(now - 86_400_000).toISOString(),
    };
    pruneMonitorState(state, now);
    expect(Object.keys(state.alertHistory)).toEqual(["fresh"]);
    expect(Object.keys(state.tokens)).toEqual(["0xlive"]);
  });
});

describe("isLevelUpgrade", () => {
  it("treats first sighting of any real level as an upgrade", () => {
    expect(isLevelUpgrade(undefined, "watch")).toBe(true);
    expect(isLevelUpgrade(undefined, "none")).toBe(false);
  });

  it("compares by rank", () => {
    expect(isLevelUpgrade("watch", "alert")).toBe(true);
    expect(isLevelUpgrade("alert", "alert")).toBe(false);
    expect(isLevelUpgrade("strong", "alert")).toBe(false);
  });
});
