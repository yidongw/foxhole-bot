import { SIGNAL_CONFIG, type SignalConfig } from "./config.js";
import type { AlertLevel, SignalEvaluation, SignalInput } from "./types.js";
import { LEVEL_RANK } from "./types.js";
import type { TokenAnalysis } from "../types.js";

function maxLevel(a: AlertLevel, b: AlertLevel): AlertLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

function daysSince(iso?: string): number | undefined {
  if (!iso) return undefined;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 0;
  return ms / (24 * 60 * 60 * 1000);
}

export function analysisToSignalInput(
  analysis: TokenAnalysis,
  extras?: Partial<SignalInput>,
): SignalInput {
  const vol = analysis.volume24hUsd ?? 0;
  const otherVol =
    analysis.pairs
      .filter((p) => p.pair !== analysis.primaryPair)
      .reduce((s, p) => s + p.volume24h, 0) /
    Math.max(analysis.pairs.length - 1, 1);

  return {
    address: analysis.address,
    chain: analysis.chain ?? "robinhood",
    symbol: analysis.symbol,
    name: analysis.name,
    primaryPair: analysis.primaryPair,
    quoteSymbol: analysis.quoteSymbol,
    isStockPaired: Boolean(
      analysis.quoteSymbol &&
        !["ETH", "WETH", "USDG", "USDC", "USDT"].includes(analysis.quoteSymbol),
    ),
    priceUsd: analysis.priceUsd,
    volume24hUsd: vol,
    liquidityUsd: analysis.liquidityUsd ?? 0,
    fdvUsd: analysis.fdvUsd,
    priceChange24h: analysis.priceChange24h,
    quoteLockRatio: analysis.quoteLockRatio,
    curveProgress: analysis.curveProgress,
    curveGraduated: analysis.curveGraduated,
    quotePremium: analysis.quotePremium,
    volumeSpikeRatio: otherVol > 0 ? vol / otherVol : undefined,
    launchAt: analysis.launchAt,
    daysSinceLaunch: daysSince(analysis.launchAt),
    longUrl: `https://app.long.xyz/tokens/${analysis.address}`,
    ...extras,
  };
}

/**
 * Score squeeze / momentum opportunities (BONER-style).
 * Returns level + human-readable reasons.
 */
export function evaluateSignal(
  input: SignalInput,
  config: SignalConfig = SIGNAL_CONFIG,
): SignalEvaluation {
  const reasons: string[] = [];
  const triggers: string[] = [];
  let level: AlertLevel = "none";
  let score = 0;

  const {
    minVolumeUsd,
    minLiquidityUsd,
    lockWatch,
    lockAlert,
    lockStrong,
    lockRiseAlert,
    lockRiseStrong,
    volumeSpikeAlert,
    volumeSpikeStrong,
    volumeAccelAlert,
    volumeAccelStrong,
    priceMomentumAlert,
    priceMomentumStrong,
    launchWatchDays,
  } = config;

  if (input.liquidityUsd < minLiquidityUsd) {
    return { level: "none", score: 0, reasons: ["liquidity too low"], triggers, input };
  }

  const lock = input.quoteLockRatio;
  const vol = input.volume24hUsd;
  const spike = input.volumeSpikeRatio;
  const accel = input.volumeAccelRatio;
  const pct = input.priceChange24h;
  const days = input.daysSinceLaunch;

  // --- New stock-paired launch (early radar) ---
  if (
    input.isStockPaired &&
    days != null &&
    days <= launchWatchDays &&
    vol >= minVolumeUsd * 0.5
  ) {
    level = maxLevel(level, "watch");
    score += 15;
    reasons.push(`new stock-paired launch (${days.toFixed(0)}d old)`);
    triggers.push("launch_watch");
  }

  // --- Quote lock squeeze (core BONER signal) ---
  if (lock != null && input.isStockPaired) {
    if (lock >= lockStrong) {
      level = maxLevel(level, "strong");
      score += 40;
      reasons.push(`quote lock ${(lock * 100).toFixed(0)}% — squeeze zone`);
      triggers.push("lock_strong");
    } else if (lock >= lockAlert) {
      level = maxLevel(level, "alert");
      score += 28;
      reasons.push(`quote lock ${(lock * 100).toFixed(0)}% — tightening`);
      triggers.push("lock_alert");
    } else if (lock >= lockWatch) {
      level = maxLevel(level, "watch");
      score += 12;
      reasons.push(`quote lock ${(lock * 100).toFixed(0)}% — building`);
      triggers.push("lock_watch");
    }
  }

  // --- Lock ratio rising between scans (the actual BONER pattern) ---
  const lockDelta = input.quoteLockDelta;
  if (
    input.isStockPaired &&
    lock != null &&
    lockDelta != null &&
    lock >= lockWatch
  ) {
    if (lockDelta >= lockRiseStrong) {
      level = maxLevel(level, "strong");
      score += 30;
      reasons.push(
        `quote lock climbing +${(lockDelta * 100).toFixed(1)}pt since last scan`,
      );
      triggers.push("lock_rising_strong");
    } else if (lockDelta >= lockRiseAlert) {
      level = maxLevel(level, "alert");
      score += 18;
      reasons.push(
        `quote lock climbing +${(lockDelta * 100).toFixed(1)}pt since last scan`,
      );
      triggers.push("lock_rising");
    }
  }

  // --- Bonding curve nearing graduation (pump.fun-style buy pressure) ---
  const { curveNearAlert, curveNearStrong } = config;
  if (
    input.curveProgress != null &&
    !input.curveGraduated &&
    vol >= minVolumeUsd * 0.5
  ) {
    if (input.curveProgress >= curveNearStrong) {
      level = maxLevel(level, "strong");
      score += 30;
      reasons.push(`curve ${(input.curveProgress * 100).toFixed(0)}% — graduation imminent`);
      triggers.push("curve_near_grad_strong");
    } else if (input.curveProgress >= curveNearAlert) {
      level = maxLevel(level, "alert");
      score += 18;
      reasons.push(`curve ${(input.curveProgress * 100).toFixed(0)}% to graduation`);
      triggers.push("curve_near_grad");
    }
  }

  // --- Volume spike vs other pairs on same token ---
  if (vol >= minVolumeUsd && spike != null) {
    if (spike >= volumeSpikeStrong) {
      level = maxLevel(level, "strong");
      score += 35;
      reasons.push(`24h vol spike ${spike.toFixed(1)}× vs other pairs`);
      triggers.push("volume_spike_strong");
    } else if (spike >= volumeSpikeAlert) {
      level = maxLevel(level, "alert");
      score += 22;
      reasons.push(`24h vol spike ${spike.toFixed(1)}× vs other pairs`);
      triggers.push("volume_spike_alert");
    }
  }

  // --- Volume acceleration vs last snapshot (monitor-only) ---
  if (accel != null && vol >= minVolumeUsd) {
    if (accel >= volumeAccelStrong) {
      level = maxLevel(level, "strong");
      score += 30;
      reasons.push(`volume accelerating ${accel.toFixed(1)}× since last scan`);
      triggers.push("volume_accel_strong");
    } else if (accel >= volumeAccelAlert) {
      level = maxLevel(level, "alert");
      score += 18;
      reasons.push(`volume accelerating ${accel.toFixed(1)}× since last scan`);
      triggers.push("volume_accel_alert");
    }
  }

  // --- Price momentum ---
  if (pct != null && vol >= minVolumeUsd) {
    if (pct >= priceMomentumStrong) {
      level = maxLevel(level, "strong");
      score += 20;
      reasons.push(`price +${pct.toFixed(0)}% 24h`);
      triggers.push("momentum_strong");
    } else if (pct >= priceMomentumAlert) {
      level = maxLevel(level, "alert");
      score += 12;
      reasons.push(`price +${pct.toFixed(0)}% 24h`);
      triggers.push("momentum_alert");
    }
  }

  // --- Composite: lock + volume = BONER weekend setup ---
  if (
    input.isStockPaired &&
    lock != null &&
    lock >= lockAlert &&
    vol >= 500_000 &&
    (spike ?? 0) >= 3
  ) {
    level = maxLevel(level, "strong");
    score += 25;
    reasons.push("BONER-style: lock tightening + volume breakout");
    triggers.push("boner_composite");
  }

  // --- Quote premium (when oracle data exists) ---
  if (input.quotePremium != null && input.quotePremium >= 1.5) {
    level = maxLevel(level, "alert");
    score += 15;
    reasons.push(`quote premium ${input.quotePremium.toFixed(2)}× vs oracle`);
    triggers.push("quote_premium");
  }

  // High absolute volume alone on stock pairs
  if (input.isStockPaired && vol >= 1_000_000) {
    level = maxLevel(level, "alert");
    score += 10;
    if (!triggers.includes("volume_spike_alert")) {
      reasons.push(`24h vol ${(vol / 1e6).toFixed(2)}M`);
      triggers.push("high_volume");
    }
  }

  return { level, score, reasons, triggers, input };
}

const CHAIN_TAGS: Record<string, string> = {
  robinhood: "RB",
  solana: "SOL",
  bsc: "BSC",
  base: "BASE",
  ethereum: "ETH",
};

export function formatSignalAlert(ev: SignalEvaluation): string {
  const i = ev.input;
  const emoji =
    ev.level === "strong" ? "🔴" : ev.level === "alert" ? "🟠" : "🟡";
  const tag = CHAIN_TAGS[i.chain ?? "robinhood"] ?? i.chain;
  const lines = [
    `${emoji} **FOXHOLE ${ev.level.toUpperCase()} [${tag}]** — ${i.symbol ?? "?"} (${i.primaryPair ?? "?"})`,
    `Score: ${ev.score} | ${ev.reasons.join(" · ")}`,
    `Vol 24h: $${((i.volume24hUsd ?? 0) / 1e6).toFixed(2)}M | Liq: $${((i.liquidityUsd ?? 0) / 1e3).toFixed(0)}K` +
      (i.quoteLockRatio != null
        ? ` | Lock: ${(i.quoteLockRatio * 100).toFixed(0)}%`
        : ""),
    `Address: \`${i.address}\``,
    i.longUrl ? `Long: ${i.longUrl}` : "",
    i.dexUrl ? `Chart: ${i.dexUrl}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}
