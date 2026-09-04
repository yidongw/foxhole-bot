import { describe, expect, it, vi } from "vitest";

import { runWithFallback } from "../src/trade/execute.js";
import { RouteError } from "../src/venues/route-error.js";
import { OkxRouteError } from "../src/venues/okx/swap.js";
import { LifiRouteError } from "../src/venues/lifi/swap.js";

// runWithFallback(router, primaryFn, hoodFn):
//   hoodchain → hoodFn; okx/lifi → primaryFn only; *_hood → primary then
//   hoodchain fallback ONLY on RouteError (pre-broadcast failure).
describe("runWithFallback", () => {
  it("hoodchain: only hoodFn runs", async () => {
    const primary = vi.fn().mockResolvedValue("primary");
    const hood = vi.fn().mockResolvedValue("hood");
    expect(await runWithFallback("hoodchain", primary, hood)).toBe("hood");
    expect(primary).not.toHaveBeenCalled();
  });

  it("okx / lifi: primary only, no fallback even on route error", async () => {
    for (const r of ["okx", "lifi"] as const) {
      const primary = vi.fn().mockRejectedValue(new RouteError("no route"));
      const hood = vi.fn().mockResolvedValue("hood");
      await expect(runWithFallback(r, primary, hood)).rejects.toBeInstanceOf(
        RouteError,
      );
      expect(hood).not.toHaveBeenCalled();
    }
  });

  it("_hood: uses primary when it succeeds", async () => {
    for (const r of ["okx_hood", "lifi_hood"] as const) {
      const primary = vi.fn().mockResolvedValue("primary");
      const hood = vi.fn().mockResolvedValue("hood");
      expect(await runWithFallback(r, primary, hood)).toBe("primary");
      expect(hood).not.toHaveBeenCalled();
    }
  });

  it("okx_hood: falls back on OkxRouteError (pre-broadcast)", async () => {
    const primary = vi.fn().mockRejectedValue(new OkxRouteError("okx down"));
    const hood = vi.fn().mockResolvedValue("hood");
    expect(await runWithFallback("okx_hood", primary, hood)).toBe("hood");
  });

  it("lifi_hood: falls back on LifiRouteError (pre-broadcast)", async () => {
    const primary = vi.fn().mockRejectedValue(new LifiRouteError("lifi no route"));
    const hood = vi.fn().mockResolvedValue("hood");
    expect(await runWithFallback("lifi_hood", primary, hood)).toBe("hood");
  });

  it("_hood: does NOT fall back on a post-broadcast error (avoids double fill)", async () => {
    const primary = vi.fn().mockRejectedValue(new Error("tx timeout after broadcast"));
    const hood = vi.fn().mockResolvedValue("hood");
    await expect(runWithFallback("lifi_hood", primary, hood)).rejects.toThrow(
      "tx timeout after broadcast",
    );
    expect(hood).not.toHaveBeenCalled();
  });
});
