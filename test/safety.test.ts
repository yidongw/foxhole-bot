import { describe, expect, it } from "vitest";

import { evaluateGoPlusFlags } from "../src/trade/safety.js";

describe("evaluateGoPlusFlags", () => {
  it("passes a clean token", () => {
    expect(
      evaluateGoPlusFlags({
        is_honeypot: "0",
        buy_tax: "0.03",
        sell_tax: "0.03",
        is_mintable: "0",
        can_take_back_ownership: "0",
        owner_change_balance: "0",
        is_open_source: "1",
      }),
    ).toEqual([]);
  });

  it("vetoes honeypots and unsellable tokens", () => {
    expect(evaluateGoPlusFlags({ is_honeypot: "1" })).toContain("honeypot");
    expect(evaluateGoPlusFlags({ cannot_sell_all: "1" })).toContain(
      "cannot_sell_all",
    );
  });

  it("vetoes taxes above 10%", () => {
    const flags = evaluateGoPlusFlags({ buy_tax: "0.15", sell_tax: "0.5" });
    expect(flags.some((f) => f.startsWith("buy_tax"))).toBe(true);
    expect(flags.some((f) => f.startsWith("sell_tax"))).toBe(true);
    expect(evaluateGoPlusFlags({ buy_tax: "0.05" })).toEqual([]);
  });

  it("vetoes owner rug mechanics", () => {
    const flags = evaluateGoPlusFlags({
      is_mintable: "1",
      can_take_back_ownership: "1",
      owner_change_balance: "1",
      hidden_owner: "1",
      selfdestruct: "1",
      transfer_pausable: "1",
      is_open_source: "0",
    });
    expect(flags).toEqual([
      "mintable",
      "ownership_recallable",
      "owner_can_edit_balances",
      "hidden_owner",
      "selfdestruct",
      "transfer_pausable",
      "closed_source",
    ]);
  });

  it("treats missing fields as clean (fail-open per field)", () => {
    expect(evaluateGoPlusFlags({})).toEqual([]);
  });
});
