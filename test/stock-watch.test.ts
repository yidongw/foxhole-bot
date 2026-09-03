import { describe, expect, it } from "vitest";

import { pickNewStocks, freshFromEntry } from "../src/chains/robinhood/stock-watch.js";

describe("pickNewStocks", () => {
  const assets = [
    { symbol: "NVDA" },
    { symbol: "FAMI", name: "Farmmi" },
    { symbol: "TSLA" },
  ];

  it("returns only symbols not already known", () => {
    const known = new Set(["NVDA", "TSLA"]);
    expect(pickNewStocks(assets, known).map((s) => s.symbol)).toEqual(["FAMI"]);
  });

  it("returns nothing when all are known", () => {
    expect(pickNewStocks(assets, new Set(["NVDA", "FAMI", "TSLA"]))).toEqual([]);
  });

  it("returns all on an empty known set", () => {
    expect(pickNewStocks(assets, new Set()).length).toBe(3);
  });
});

describe("freshFromEntry", () => {
  const now = Date.parse("2026-09-03T00:00:00Z");

  it("flags a recently-added listing", () => {
    const r = freshFromEntry(
      { firstSeenAt: "2026-09-01T00:00:00Z", seeded: false, name: "Farmmi" },
      now,
      7,
    );
    expect(r?.ageDays).toBeCloseTo(2, 1);
    expect(r?.name).toBe("Farmmi");
  });

  it("never flags a seeded (bootstrap) stock", () => {
    expect(
      freshFromEntry({ firstSeenAt: "2026-09-02T00:00:00Z", seeded: true }, now, 7),
    ).toBeUndefined();
  });

  it("does not flag a listing older than the window", () => {
    expect(
      freshFromEntry({ firstSeenAt: "2026-08-01T00:00:00Z", seeded: false }, now, 7),
    ).toBeUndefined();
  });

  it("returns undefined for a missing entry", () => {
    expect(freshFromEntry(undefined, now, 7)).toBeUndefined();
  });
});
