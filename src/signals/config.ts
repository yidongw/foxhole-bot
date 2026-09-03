import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SignalConfig = typeof SIGNAL_CONFIG;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const OVERRIDES_PATH = path.resolve(
  __dirname,
  "../../data/signal-overrides.json",
);

export interface SignalOverridesFile {
  updated_at: string;
  reason: string;
  /** Partial config diff vs the compiled SIGNAL_CONFIG defaults. */
  config: Partial<SignalConfig>;
  history?: Array<{ at: string; reason: string; config: Partial<SignalConfig> }>;
}

let cached: { config: SignalConfig; at: number } | undefined;
const CACHE_MS = 60_000;

/**
 * Runtime signal config: compiled defaults merged with the auto-tuner's
 * data/signal-overrides.json (config-as-data — revert by deleting the file).
 */
export function loadSignalConfig(): SignalConfig {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.config;
  let config: SignalConfig = SIGNAL_CONFIG;
  try {
    const raw = JSON.parse(readFileSync(OVERRIDES_PATH, "utf8")) as SignalOverridesFile;
    config = { ...SIGNAL_CONFIG, ...raw.config };
  } catch {
    // no overrides — defaults
  }
  cached = { config, at: Date.now() };
  return config;
}

/** Test hook. */
export function clearSignalConfigCache(): void {
  cached = undefined;
}

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

  /**
   * 24h change above this = the pump already happened (事后警报). Signals
   * must fire BEFORE pumps — DIDDY (+3136%), NUDES (+281638%) and the
   * "I" entry at +932% (-$14.33) were all momentum echoes, not entries.
   * Such evaluations cap at "alert" (still counts as captured for the
   * tuner) and carry a post_pump trigger that vetoes engine entries.
   */
  postPumpMaxChangePct: 500,

  /**
   * Minimum FDV for a TRADE-grade signal. Below this a token is nano-dust:
   * "I" (single-letter meme, $288K FDV, $137K liq fragmented across 14
   * pools) pumped +450% and auto-bought because momentum/volume/stock-pair
   * triggers all fired — but a $288K cap should never be an entry. Real RB
   * memes that mattered (JINQIAN, PONS, BONER) were all $M+. Undefined FDV
   * fails open (no demotion) so missing data doesn't blind the radar.
   */
  minTradeFdvUsd: 1_000_000,

  /**
   * 24h drop beyond this while volume triggers fire = distribution, not a
   * breakout. The spike/accel triggers compare against peer pairs or the
   * last scan snapshot, so sell-off volume on a falling token reads as
   * "acceleration" (BONER 2026-09-03: -24% 24h yet score 160 with
   * volume_accel 3.8× — the decider had to veto it from live orderflow).
   * Cap at alert + falling_knife trigger; engine refuses the entry.
   */
  fallingKnifeDropPct: 10,

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
