import { fetchPoolOhlcv } from "../dex/dexpaprika.js";
import { evaluateSignal } from "../signals/evaluate.js";
import type { SignalConfig } from "../signals/config.js";
import type { AlertLevel, SignalInput } from "../signals/types.js";
import { LEVEL_RANK } from "../signals/types.js";
import type { OhlcvCandle } from "../dex/dexpaprika.js";

export interface TokenBacktestFixture {
  kind: "pump" | "control";
  symbol: string;
  address: string;
  /** DexPaprika pool id — a DexScreener pairAddress works on every chain. */
  poolId: string;
  /** DexPaprika network slug; default robinhood. */
  network?: string;
  quoteSymbol: string;
  launchAt: string;
  ohlcvStart: string;
  notes?: string;
}

export interface ReplayAlert {
  date: string;
  level: AlertLevel;
  score: number;
  reasons: string[];
  volume24hUsd: number;
  priceChange24h?: number;
  volumeAccelRatio?: number;
  volumeSpikeRatio?: number;
}

export interface TokenReplayResult {
  fixture: TokenBacktestFixture;
  candles: number;
  peakDate: string;
  peakVolume: number;
  firstAlertDate?: string;
  firstAlertLevel?: AlertLevel;
  maxLevel: AlertLevel;
  alerts: ReplayAlert[];
  passed: boolean;
  failureReason?: string;
  dataSource: "dexpaprika-ohlcv";
}

function higherLevel(a: AlertLevel, b: AlertLevel): AlertLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

function findPeakDay(candles: OhlcvCandle[]): { date: string; volume: number } {
  let peak = candles[0];
  for (const c of candles) {
    if (c.volume > peak.volume) peak = c;
  }
  return { date: peak.time_open.slice(0, 10), volume: peak.volume };
}

function candleToSignalInput(
  fixture: TokenBacktestFixture,
  candle: OhlcvCandle,
  prev: OhlcvCandle | undefined,
  priorVolumes: number[],
  liquidityUsd: number,
): SignalInput {
  const volume24hUsd = candle.volume;
  const prevVol = prev?.volume ?? 0;
  const volumeAccelRatio =
    prevVol > 0 ? volume24hUsd / prevVol : undefined;
  const rolling =
    priorVolumes.length > 0
      ? priorVolumes.reduce((a, b) => a + b, 0) / priorVolumes.length
      : undefined;
  const volumeSpikeRatio =
    rolling && rolling > 0 ? volume24hUsd / rolling : undefined;
  const priceChange24h =
    prev && prev.close > 0
      ? ((candle.close - prev.close) / prev.close) * 100
      : undefined;
  const launchMs = new Date(fixture.launchAt).getTime();
  const dayMs = new Date(candle.time_open).getTime();
  const daysSinceLaunch = (dayMs - launchMs) / (24 * 60 * 60 * 1000);

  return {
    address: fixture.address,
    chain: fixture.network ?? "robinhood",
    symbol: fixture.symbol,
    primaryPair: `${fixture.symbol}/${fixture.quoteSymbol}`,
    quoteSymbol: fixture.quoteSymbol,
    // Stock-pair signals (launch watch, high-volume rule) are Robinhood-only
    isStockPaired: (fixture.network ?? "robinhood") === "robinhood",
    volume24hUsd,
    liquidityUsd,
    priceChange24h,
    volumeSpikeRatio,
    volumeAccelRatio,
    daysSinceLaunch: Math.max(0, daysSinceLaunch),
    launchAt: fixture.launchAt,
    longUrl: `https://app.long.xyz/tokens/${fixture.address}`,
  };
}

/**
 * Walk-forward replay: at each day, only use data available up to that point
 * (simulates live monitor polling once per day).
 */
export async function replayTokenHistory(
  fixture: TokenBacktestFixture,
  options?: { liquidityUsd?: number; config?: SignalConfig },
): Promise<TokenReplayResult> {
  const candles = await fetchPoolOhlcv(fixture.poolId, {
    start: fixture.ohlcvStart,
    interval: "24h",
    limit: 120,
    network: fixture.network,
  });
  return replayCandles(fixture, candles, options);
}

/** Pure replay over pre-fetched candles — reused by the grid search. */
export function replayCandles(
  fixture: TokenBacktestFixture,
  candles: OhlcvCandle[],
  options?: { liquidityUsd?: number; config?: SignalConfig },
): TokenReplayResult {
  const liquidityUsd = options?.liquidityUsd ?? 100_000;
  const priorVolumes: number[] = [];
  let maxLevel: AlertLevel = "none";
  let firstAlertDate: string | undefined;
  let firstAlertLevel: AlertLevel | undefined;
  const alerts: ReplayAlert[] = [];
  let prev: OhlcvCandle | undefined;

  for (const candle of candles) {
    const input = candleToSignalInput(
      fixture,
      candle,
      prev,
      priorVolumes.slice(-7),
      liquidityUsd,
    );
    const ev = evaluateSignal(input, options?.config);
    maxLevel = higherLevel(maxLevel, ev.level);

    if (LEVEL_RANK[ev.level] >= LEVEL_RANK.alert) {
      const date = candle.time_open.slice(0, 10);
      alerts.push({
        date,
        level: ev.level,
        score: ev.score,
        reasons: ev.reasons,
        volume24hUsd: input.volume24hUsd,
        priceChange24h: input.priceChange24h,
        volumeAccelRatio: input.volumeAccelRatio,
        volumeSpikeRatio: input.volumeSpikeRatio,
      });
      if (!firstAlertDate) {
        firstAlertDate = date;
        firstAlertLevel = ev.level;
      }
    }

    priorVolumes.push(candle.volume);
    prev = candle;
  }

  const peak = findPeakDay(candles);
  let passed = false;
  let failureReason: string | undefined;

  if (fixture.kind === "pump") {
    if (!firstAlertDate) {
      passed = false;
      failureReason = "never alerted before/during pump";
    } else if (firstAlertDate > peak.date) {
      passed = false;
      failureReason = `first alert ${firstAlertDate} is AFTER peak volume day ${peak.date}`;
    } else {
      passed = true;
    }
  } else {
    if (LEVEL_RANK[maxLevel] >= LEVEL_RANK.alert) {
      passed = false;
      failureReason = `false positive: reached ${maxLevel} (max should be watch or below)`;
    } else {
      passed = true;
    }
  }

  return {
    fixture,
    candles: candles.length,
    peakDate: peak.date,
    peakVolume: peak.volume,
    firstAlertDate,
    firstAlertLevel,
    maxLevel,
    alerts,
    passed,
    failureReason,
    dataSource: "dexpaprika-ohlcv",
  };
}

export function formatReplayReport(results: TokenReplayResult[]): string {
  const passed = results.filter((r) => r.passed).length;
  const lines = [
    `Historical replay backtest (DexPaprika OHLCV): ${passed}/${results.length} passed`,
    "",
  ];

  for (const r of results) {
    const mark = r.passed ? "✅" : "❌";
    const kind = r.fixture.kind === "pump" ? "PUMP" : "CONTROL";
    lines.push(`${mark} [${kind}] ${r.fixture.symbol} — ${r.fixture.notes ?? ""}`);
    lines.push(`   candles: ${r.candles} | peak vol day: ${r.peakDate} ($${Math.round(r.peakVolume).toLocaleString()})`);
    if (r.fixture.kind === "pump") {
      lines.push(
        `   first alert: ${r.firstAlertDate ?? "NEVER"} (${r.firstAlertLevel ?? "—"})`,
      );
    } else {
      lines.push(`   max level: ${r.maxLevel}`);
    }
    if (r.alerts.length) {
      for (const a of r.alerts.slice(0, 5)) {
        lines.push(
          `   → ${a.date} ${a.level.toUpperCase()} score=${a.score} vol=$${Math.round(a.volume24hUsd).toLocaleString()} ${a.reasons.slice(0, 2).join(" · ")}`,
        );
      }
      if (r.alerts.length > 5) {
        lines.push(`   … +${r.alerts.length - 5} more alert days`);
      }
    }
    if (r.failureReason) lines.push(`   FAIL: ${r.failureReason}`);
    lines.push("");
  }

  return lines.join("\n");
}
