import { describe, expect, it } from "vitest";

import { evaluateGoPlusFlags } from "../src/trade/safety.js";
import {
  classifyStockQuote,
  type StockRegistry,
} from "../src/chains/robinhood/stock-registry.js";

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

describe("classifyStockQuote", () => {
  const registry: StockRegistry = {
    addresses: new Set(["0xccee82fe024c36fa15e1005ede3e9e4787e23d09"]), // HIMS
    symbols: new Set(["HIMS", "NVDA", "TSLA"]),
  };

  it("passes the real registry address as official (case-insensitive)", () => {
    expect(
      classifyStockQuote(
        "HIMS",
        "0xCceE82fE024c36fA15E1005edE3E9e4787e23D09",
        "robinhood",
        registry,
      ),
    ).toBe("official");
  });

  it("vetoes a stock symbol whose address is not in the registry", () => {
    expect(
      classifyStockQuote("NVDA", "0xdeadbeef", "robinhood", registry),
    ).toBe("fake");
  });

  it("vetoes any stock-symbol quote off Robinhood Chain (4663-only)", () => {
    expect(
      classifyStockQuote(
        "HIMS",
        "0xCceE82fE024c36fA15E1005edE3E9e4787e23D09",
        "solana",
        registry,
      ),
    ).toBe("fake");
  });

  it("ignores non-stock quote symbols", () => {
    expect(classifyStockQuote("WETH", "0xabc", "robinhood", registry)).toBe(
      "not_stock",
    );
    expect(classifyStockQuote("BONER", "0xabc", "base", registry)).toBe(
      "not_stock",
    );
  });

  it("leaves variant symbols alone (no hard veto on different assets)", () => {
    expect(
      classifyStockQuote("NVDAx3L", "0xabc", "robinhood", registry),
    ).toBe("not_stock");
  });

  it("fails open when the registry is unavailable", () => {
    expect(classifyStockQuote("NVDA", "0xdeadbeef", "robinhood", undefined)).toBe(
      "unknown",
    );
  });
});
