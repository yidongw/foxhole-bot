import { type Address, type Hex, getAddress } from "viem";

import {
  fetchPoolOhlcv,
  fetchPoolOhlcvRange,
  fetchPoolMeta,
  type OhlcvCandle,
  type OhlcvInterval,
} from "../dex/dexpaprika.js";
import {
  estimateBlockForTime,
  sampleQuoteLockAtBlock,
  supportsArchiveRpc,
  type PoolLockAnchor,
} from "../chain/historical-lock.js";
import { evaluateSignal } from "../signals/evaluate.js";
import type { AlertLevel, SignalInput } from "../signals/types.js";
import { LEVEL_RANK } from "../signals/types.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SqueezeWindow {
  /** Fetch candles from here for rolling 24h warmup. */
  warmupStart: string;
  /** First candle in squeeze window (alerts counted from here). */
  start: string;
  end: string;
}

export interface TokenBacktestFixture {
  kind: "pump" | "control";
  symbol: string;
  address: string;
  poolId: string;
  quoteSymbol: string;
  launchAt: string;
  ohlcvStart: string;
  squeezeWindow?: SqueezeWindow;
  notes?: string;
}

export interface ReplayAlert {
  /** Candle open (ISO, minute precision). */
  at: string;
  /** Candle close — earliest moment this tick's data is known. */
  firesAt: string;
  date: string;
  level: AlertLevel;
  score: number;
  reasons: string[];
  volume24hUsd: number;
  priceChange24h?: number;
  volumeAccelRatio?: number;
  volumeSpikeRatio?: number;
  quoteLockRatio?: number;
  lockSource?: string;
}

export interface TokenReplayResult {
  fixture: TokenBacktestFixture;
  interval: OhlcvInterval;
  candles: number;
  peakDate: string;
  peakVolume: number;
  /** First alert in squeeze window (pump tokens). */
  squeezeFirstAlertAt?: string;
  squeezeFirstAlertFiresAt?: string;
  squeezeFirstAlertLevel?: AlertLevel;
  firstAlertAt?: string;
  firstAlertLevel?: AlertLevel;
  maxLevel: AlertLevel;
  alerts: ReplayAlert[];
  lockSamples: number;
  archiveRpc: boolean;
  passed: boolean;
  failureReason?: string;
  dataSource: "dexpaprika-ohlcv+archive-lock";
}

function higherLevel(a: AlertLevel, b: AlertLevel): AlertLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

function safeVolume(v: number): number {
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

function rolling24hVolumeFromSeries(
  series: OhlcvCandle[],
  endIndex: number,
): number {
  const endTime = new Date(series[endIndex]!.time_close).getTime();
  const startTime = endTime - WINDOW_MS;
  let sum = 0;
  for (let i = endIndex; i >= 0; i--) {
    const closeMs = new Date(series[i]!.time_close).getTime();
    if (closeMs < startTime) break;
    sum += safeVolume(series[i]!.volume);
  }
  return sum;
}

function rolling24hVolume(
  warmup: OhlcvCandle[],
  candles: OhlcvCandle[],
  endIndex: number,
): number {
  const candle = candles[endIndex]!;
  const endTime = new Date(candle.time_close).getTime();
  const startTime = endTime - WINDOW_MS;
  let sum = 0;

  for (let i = endIndex; i >= 0; i--) {
    const closeMs = new Date(candles[i]!.time_close).getTime();
    if (closeMs < startTime) break;
    sum += safeVolume(candles[i]!.volume);
  }

  for (let i = warmup.length - 1; i >= 0; i--) {
    const c = warmup[i]!;
    const closeMs = new Date(c.time_close).getTime();
    if (closeMs < startTime) break;
    if (closeMs <= new Date(candles[0]!.time_open).getTime()) {
      sum += safeVolume(c.volume);
    }
  }

  return sum;
}

function priceChange1h(
  warmup: OhlcvCandle[],
  candles: OhlcvCandle[],
  endIndex: number,
): number | undefined {
  const endTime = new Date(candles[endIndex]!.time_close).getTime();
  const target = endTime - 60 * 60 * 1000;
  const series = [...warmup, ...candles];
  let ref: OhlcvCandle | undefined;
  for (let i = series.length - 1; i >= 0; i--) {
    const c = series[i]!;
    const openMs = new Date(c.time_open).getTime();
    if (openMs <= target) {
      ref = c;
      break;
    }
  }
  const cur = candles[endIndex]!;
  if (!ref || ref.close <= 0) return undefined;
  return ((cur.close - ref.close) / ref.close) * 100;
}

function priceChange24h(
  warmup: OhlcvCandle[],
  candles: OhlcvCandle[],
  endIndex: number,
): number | undefined {
  const endTime = new Date(candles[endIndex]!.time_close).getTime();
  const target = endTime - WINDOW_MS;
  const series = [...warmup, ...candles];
  let ref: OhlcvCandle | undefined;
  for (let i = series.length - 1; i >= 0; i--) {
    const c = series[i]!;
    const openMs = new Date(c.time_open).getTime();
    if (openMs <= target) {
      ref = c;
      break;
    }
  }
  const cur = candles[endIndex]!;
  if (!ref || ref.close <= 0) return undefined;
  return ((cur.close - ref.close) / ref.close) * 100;
}

function findPeakVolume(candles: OhlcvCandle[]): {
  at: string;
  date: string;
  volume: number;
} {
  if (!candles.length) return { at: "—", date: "—", volume: 0 };
  let peakAt = candles[0]!.time_open;
  let peakVol = 0;
  for (let i = 0; i < candles.length; i++) {
    const vol = rolling24hVolumeFromSeries(candles, i);
    if (vol > peakVol) {
      peakVol = vol;
      peakAt = candles[i]!.time_open;
    }
  }
  return { at: peakAt, date: peakAt.slice(0, 10), volume: peakVol };
}

function buildSignalInput(
  fixture: TokenBacktestFixture,
  candle: OhlcvCandle,
  priorRolling24h: number[],
  volume24hUsd: number,
  priceChg24h: number | undefined,
  priceChg1h: number | undefined,
  quoteLockRatio?: number,
): SignalInput {
  const prevVol24h = priorRolling24h.at(-1);
  const volumeAccelRatio =
    prevVol24h && prevVol24h > 0 ? volume24hUsd / prevVol24h : undefined;
  const rolling =
    priorRolling24h.length > 0
      ? priorRolling24h.reduce((a, b) => a + b, 0) / priorRolling24h.length
      : undefined;
  const volumeSpikeRatio =
    rolling && rolling > 0 ? volume24hUsd / rolling : undefined;
  const launchMs = new Date(fixture.launchAt).getTime();
  const dayMs = new Date(candle.time_open).getTime();
  const daysSinceLaunch = (dayMs - launchMs) / (24 * 60 * 60 * 1000);

  return {
    address: fixture.address,
    symbol: fixture.symbol,
    primaryPair: `${fixture.symbol}/${fixture.quoteSymbol}`,
    quoteSymbol: fixture.quoteSymbol,
    isStockPaired: true,
    volume24hUsd,
    liquidityUsd: 100_000,
    priceChange24h: priceChg24h,
    priceChange1h: priceChg1h,
    quoteLockRatio,
    volumeSpikeRatio,
    volumeAccelRatio,
    daysSinceLaunch: Math.max(0, daysSinceLaunch),
    launchAt: fixture.launchAt,
    longUrl: `https://app.long.xyz/tokens/${fixture.address}`,
  };
}

function defaultInterval(fixture: TokenBacktestFixture): OhlcvInterval {
  return fixture.kind === "pump" ? "1m" : "1h";
}

async function loadCandles(
  fixture: TokenBacktestFixture,
  interval: OhlcvInterval,
): Promise<{
  candles: OhlcvCandle[];
  warmupCandles: OhlcvCandle[];
  effectiveInterval: OhlcvInterval;
}> {
  const sw = fixture.squeezeWindow;
  const useFine =
    sw && (interval === "1m" || interval === "5m" || interval === "15m");

  if (useFine) {
    const [warmupCandles, candles] = await Promise.all([
      fetchPoolOhlcvRange(fixture.poolId, {
        start: sw.warmupStart,
        end: sw.start,
        interval: "1h",
      }),
      fetchPoolOhlcvRange(fixture.poolId, {
        start: sw.start,
        end: sw.end,
        interval,
      }),
    ]);
    return { candles, warmupCandles, effectiveInterval: interval };
  }

  let effectiveInterval = interval;
  let candles = await fetchPoolOhlcv(fixture.poolId, {
    start: fixture.ohlcvStart,
    interval: effectiveInterval,
    limit: effectiveInterval === "1h" ? 366 : 120,
  });
  if (!candles.length && effectiveInterval === "1h") {
    effectiveInterval = "24h";
    candles = await fetchPoolOhlcv(fixture.poolId, {
      start: fixture.ohlcvStart,
      interval: "24h",
      limit: 120,
    });
  }
  return { candles, warmupCandles: [], effectiveInterval };
}

export interface ReplayOptions {
  interval?: OhlcvInterval;
  withLock?: boolean;
}

/**
 * Walk-forward replay using real DexPaprika OHLCV.
 * Pump tokens default to 1m candles inside squeezeWindow (minute-level alerts).
 */
export async function replayTokenHistory(
  fixture: TokenBacktestFixture,
  options: ReplayOptions = {},
): Promise<TokenReplayResult> {
  const interval = options.interval ?? defaultInterval(fixture);
  const withLock = options.withLock ?? true;

  const poolMeta = await fetchPoolMeta(fixture.poolId);
  const { candles, warmupCandles, effectiveInterval } = await loadCandles(
    fixture,
    interval,
  );

  if (!candles.length) {
    return {
      fixture,
      interval: effectiveInterval,
      candles: 0,
      peakDate: "—",
      peakVolume: 0,
      maxLevel: "none",
      alerts: [],
      lockSamples: 0,
      archiveRpc: supportsArchiveRpc(),
      passed: fixture.kind === "control",
      failureReason:
        fixture.kind === "pump" ? "no OHLCV history from DexPaprika" : undefined,
      dataSource: "dexpaprika-ohlcv+archive-lock",
    };
  }

  const squeezeStartMs = fixture.squeezeWindow
    ? new Date(fixture.squeezeWindow.start).getTime()
    : 0;
  const squeezeEndMs = fixture.squeezeWindow
    ? new Date(fixture.squeezeWindow.end).getTime()
    : Infinity;

  const quoteToken = getAddress(poolMeta.quote_token_id) as Address;
  const token0IsQuote = false;

  const lockAnchor: PoolLockAnchor = {
    createdAtBlock: poolMeta.created_at_block_number,
    createdAtMs: new Date(poolMeta.created_at).getTime(),
  };

  const priorRolling24h: number[] = [];
  for (let wi = 0; wi < warmupCandles.length; wi++) {
    priorRolling24h.push(rolling24hVolumeFromSeries(warmupCandles, wi));
  }

  let maxLevel: AlertLevel = "none";
  let squeezeMaxLevel: AlertLevel = "none";
  let firstAlertAt: string | undefined;
  let firstAlertLevel: AlertLevel | undefined;
  let squeezeFirstAlertAt: string | undefined;
  let squeezeFirstAlertFiresAt: string | undefined;
  let squeezeFirstAlertLevel: AlertLevel | undefined;
  const alerts: ReplayAlert[] = [];
  let lockSamples = 0;
  let lastQuoteLockRatio: number | undefined;
  let lockSampleCounter = 0;

  const squeezeCandles: OhlcvCandle[] = candles;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    const openMs = new Date(candle.time_open).getTime();
    const inSqueeze =
      openMs >= squeezeStartMs && openMs <= squeezeEndMs;
    const volume24hUsd = rolling24hVolume(warmupCandles, candles, i);
    const priceChg24h = priceChange24h(warmupCandles, candles, i);
    const priceChg1h = priceChange1h(warmupCandles, candles, i);

    let lockSource: string | undefined;

    if (withLock && supportsArchiveRpc()) {
      lockSampleCounter++;
      const shouldSample =
        effectiveInterval === "24h" ||
        lockSampleCounter % 60 === 0 ||
        volume24hUsd >= 50_000;
      if (shouldSample) {
        const closeMs = new Date(candle.time_close).getTime();
        const block = estimateBlockForTime(lockAnchor, closeMs);
        const lockSample = await sampleQuoteLockAtBlock(
          fixture.poolId as Hex,
          quoteToken,
          token0IsQuote,
          block,
        );
        if (lockSample) {
          lastQuoteLockRatio = lockSample.quoteLockRatio;
          lockSource = `block ${lockSample.blockNumber}`;
          lockSamples++;
        }
      }
    }

    const quoteLockRatio = lastQuoteLockRatio;
    const input = buildSignalInput(
      fixture,
      candle,
      priorRolling24h,
      volume24hUsd,
      priceChg24h,
      priceChg1h,
      quoteLockRatio,
    );
    const ev = evaluateSignal(input);
    maxLevel = higherLevel(maxLevel, ev.level);
    if (inSqueeze) squeezeMaxLevel = higherLevel(squeezeMaxLevel, ev.level);

    if (LEVEL_RANK[ev.level] >= LEVEL_RANK.alert && inSqueeze) {
      const at = candle.time_open;
      const firesAt = candle.time_close;
      alerts.push({
        at,
        firesAt,
        date: at.slice(0, 10),
        level: ev.level,
        score: ev.score,
        reasons: ev.reasons,
        volume24hUsd: input.volume24hUsd,
        priceChange24h: input.priceChange24h,
        volumeAccelRatio: input.volumeAccelRatio,
        volumeSpikeRatio: input.volumeSpikeRatio,
        quoteLockRatio,
        lockSource,
      });
      if (!firstAlertAt) {
        firstAlertAt = at;
        firstAlertLevel = ev.level;
      }
      if (!squeezeFirstAlertAt) {
        squeezeFirstAlertAt = at;
        squeezeFirstAlertFiresAt = firesAt;
        squeezeFirstAlertLevel = ev.level;
      }
    }

    priorRolling24h.push(volume24hUsd);
  }

  const peak = findPeakVolume(
    squeezeCandles.length ? squeezeCandles : candles,
  );

  let passed = false;
  let failureReason: string | undefined;

  if (fixture.kind === "pump") {
    const alertAt = squeezeFirstAlertFiresAt ?? squeezeFirstAlertAt;
    if (!alertAt) {
      passed = false;
      failureReason = "never alerted during squeeze window";
    } else if (alertAt > peak.at) {
      passed = false;
      failureReason = `first squeeze alert ${alertAt} is AFTER peak volume ${peak.at}`;
    } else {
      passed = true;
    }
  } else {
    if (LEVEL_RANK[maxLevel] >= LEVEL_RANK.alert) {
      passed = false;
      failureReason = `false positive: reached ${maxLevel}`;
    } else {
      passed = true;
    }
  }

  return {
    fixture,
    interval: effectiveInterval,
    candles: candles.length,
    peakDate: peak.date,
    peakVolume: peak.volume,
    squeezeFirstAlertAt,
    squeezeFirstAlertFiresAt,
    squeezeFirstAlertLevel,
    firstAlertAt,
    firstAlertLevel,
    maxLevel: fixture.kind === "pump" ? squeezeMaxLevel : maxLevel,
    alerts,
    lockSamples,
    archiveRpc: supportsArchiveRpc(),
    passed,
    failureReason,
    dataSource: "dexpaprika-ohlcv+archive-lock",
  };
}

export function formatReplayReport(results: TokenReplayResult[]): string {
  const passed = results.filter((r) => r.passed).length;
  const archive = results[0]?.archiveRpc ?? false;
  const intervals = [...new Set(results.map((r) => r.interval))].join("/");
  const lines = [
    `Historical replay (DexPaprika ${intervals} OHLCV, rolling 24h vol)`,
    `Alert precision: pump=1m candle (fires at candle close); control=1h`,
    `Archive RPC lock sampling: ${archive ? "ON" : "OFF — set Alchemy ROBINHOOD_RPC for lock ratio"}`,
    `Result: ${passed}/${results.length} passed`,
    "",
  ];

  for (const r of results) {
    const mark = r.passed ? "✅" : "❌";
    const kind = r.fixture.kind === "pump" ? "PUMP" : "CONTROL";
    lines.push(`${mark} [${kind}] ${r.fixture.symbol} (${r.interval}, ${r.candles} candles)`);
    lines.push(`   ${r.fixture.notes ?? ""}`);
    lines.push(
      `   peak rolling-24h vol: ${r.peakDate} $${Math.round(r.peakVolume).toLocaleString()} | lock samples: ${r.lockSamples}`,
    );

    if (r.fixture.kind === "pump") {
      lines.push(
        `   🔔 SQUEEZE FIRST ALERT: open=${r.squeezeFirstAlertAt ?? "NEVER"} fires=${r.squeezeFirstAlertFiresAt ?? "—"} → ${r.squeezeFirstAlertLevel ?? "—"}`,
      );
    } else {
      lines.push(`   max level: ${r.maxLevel}`);
    }

    if (r.alerts.length) {
      const shown = r.alerts.slice(0, 20);
      const more = r.alerts.length - shown.length;
      lines.push("   squeeze alert timeline (open → fires):");
      for (const a of shown) {
        const lock =
          a.quoteLockRatio != null
            ? ` lock=${(a.quoteLockRatio * 100).toFixed(0)}%`
            : "";
        lines.push(
          `     ${a.at} → ${a.firesAt} ${a.level.toUpperCase()} score=${a.score} vol24h=$${Math.round(a.volume24hUsd).toLocaleString()}${lock}`,
        );
        lines.push(`       ${a.reasons.join(" · ")}`);
      }
      if (more > 0) lines.push(`     … +${more} more alerts`);
    }

    if (r.failureReason) lines.push(`   FAIL: ${r.failureReason}`);
    lines.push("");
  }

  return lines.join("\n");
}
