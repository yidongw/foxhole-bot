import { describe, expect, it } from "vitest";

import {
  isLevelUpgrade,
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
