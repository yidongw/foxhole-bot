/** Tunable thresholds — calibrated against BONER Aug 2026 squeeze case study. */
export const SIGNAL_CONFIG = {
  /** Minimum 24h volume (USD) before any non-launch alert fires. */
  minVolumeUsd: 100_000,

  /** Quote lock ratio tiers (HIMS-style squeeze). */
  lockWatch: 0.25,
  lockAlert: 0.3,
  lockStrong: 0.45,

  /**
   * Lock ratio rise vs previous monitor snapshot (percentage points, 0-1
   * scale). The BONER squeeze signature was the lock *climbing*, not just
   * its absolute level.
   */
  lockRiseAlert: 0.03,
  lockRiseStrong: 0.07,

  /** Volume spike vs peer pairs on same token. */
  volumeSpikeAlert: 5,
  volumeSpikeStrong: 8,

  /** Volume acceleration vs our last snapshot (monitor loop). */
  volumeAccelAlert: 2.5,
  volumeAccelStrong: 4,

  /** Price momentum 24h %. */
  priceMomentumAlert: 20,
  priceMomentumStrong: 40,

  /** New Long.xyz stock-paired launch watch window. */
  launchWatchDays: 14,

  /** Bonding-curve graduation proximity (pump.fun-style launchpads). */
  curveNearAlert: 0.8,
  curveNearStrong: 0.92,

  /** Minimum liquidity to avoid noise. */
  minLiquidityUsd: 10_000,

  /** Re-alert cooldown per token+level (ms). */
  alertCooldownMs: 6 * 60 * 60 * 1000,

  /** Poll interval default (ms). */
  pollIntervalMs: 5 * 60 * 1000,
} as const;

export const BONER_ADDRESS =
  "0x98096d17e191b3da1d5f99a6d7b3584351b11e18" as const;
