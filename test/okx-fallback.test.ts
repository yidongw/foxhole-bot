import { describe, expect, it, vi } from "vitest";

import { runWithFallback } from "../src/trade/execute.js";
import { OkxRouteError } from "../src/venues/okx/swap.js";

describe("runWithFallback", () => {
  it("hoodchain: only hoodFn runs", async () => {
    const okx = vi.fn().mockResolvedValue("okx");
    const hood = vi.fn().mockResolvedValue("hood");
    expect(await runWithFallback("hoodchain", okx, hood)).toBe("hood");
    expect(okx).not.toHaveBeenCalled();
    expect(hood).toHaveBeenCalledOnce();
  });

  it("okx: only okxFn runs, no fallback even on route error", async () => {
    const okx = vi.fn().mockRejectedValue(new OkxRouteError("no route"));
    const hood = vi.fn().mockResolvedValue("hood");
    await expect(runWithFallback("okx", okx, hood)).rejects.toBeInstanceOf(
      OkxRouteError,
    );
    expect(hood).not.toHaveBeenCalled();
  });

  it("okx_hood: uses OKX when it succeeds", async () => {
    const okx = vi.fn().mockResolvedValue("okx");
    const hood = vi.fn().mockResolvedValue("hood");
    expect(await runWithFallback("okx_hood", okx, hood)).toBe("okx");
    expect(hood).not.toHaveBeenCalled();
  });

  it("okx_hood: falls back to hoodchain on OkxRouteError (pre-broadcast)", async () => {
    const okx = vi.fn().mockRejectedValue(new OkxRouteError("okx api down"));
    const hood = vi.fn().mockResolvedValue("hood");
    expect(await runWithFallback("okx_hood", okx, hood)).toBe("hood");
    expect(okx).toHaveBeenCalledOnce();
    expect(hood).toHaveBeenCalledOnce();
  });

  it("okx_hood: does NOT fall back on a post-broadcast error (avoids double fill)", async () => {
    // A generic Error models a failure after the swap tx was broadcast.
    const okx = vi.fn().mockRejectedValue(new Error("tx timeout after broadcast"));
    const hood = vi.fn().mockResolvedValue("hood");
    await expect(runWithFallback("okx_hood", okx, hood)).rejects.toThrow(
      "tx timeout after broadcast",
    );
    expect(hood).not.toHaveBeenCalled();
  });
});
