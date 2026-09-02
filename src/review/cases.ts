import type { OhlcvCandle } from "../dex/dexpaprika.js";
import { fetchPoolOhlcv } from "../dex/dexpaprika.js";
import { evaluateSignal } from "../signals/evaluate.js";
import type { SignalConfig } from "../signals/config.js";
import { LEVEL_RANK } from "../signals/types.js";
import { sleep } from "../lib/utils.js";
import type { LabeledOutcome } from "./ledger.js";
import type { MissedCase } from "./movers.js";

/**
 * Hourly walk-forward replay with live-monitor semantics:
 * - volume24hUsd  = rolling 24h sum at each hour
 * - accel         = rolling24(t) / rolling24(t-1h)   (like scan-to-scan)
 * - priceChange24h= close(t) / close(t-24h) - 1
 * - spike         = rolling24(t) / mean rolling24 over hours 24-48 back
 */

export interface HourlyReplayResult {
  passed: boolean;
  firstAlertAt?: string;
  peakAt: string;
  alertHours: number;
}

export interface ReviewCase {
  kind: "pump" | "control";
  source: "win" | "loss" | "missed";
  chain: string;
  address: string;
  symbol?: string;
  poolId: string;
  /** Window anchor (alert time or detection time). */
  anchorAt: string;
  liquidityUsd: number;
  candles: OhlcvCandle[];
}

export function replayHourlyCase(
  kase: Pick<ReviewCase, "kind" | "chain" | "address" | "symbol" | "liquidityUsd" | "candles">,
  config: SignalConfig,
): HourlyReplayResult {
  const candles = kase.candles;
  const rolling: number[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].volume;
    if (i >= 24) sum -= candles[i - 24].volume;
    rolling.push(sum);
  }

  let peakIdx = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[peakIdx].close) peakIdx = i;
  }

  let firstAlertIdx: number | undefined;
  let alertHours = 0;
  for (let i = 24; i < candles.length; i++) {
    const baselineWindow = rolling.slice(Math.max(24, i - 48), Math.max(25, i - 24));
    const baseline = baselineWindow.length
      ? baselineWindow.reduce((a, b) => a + b, 0) / baselineWindow.length
      : 0;
    const prevClose = candles[i - 24].close;
    const evaluation = evaluateSignal(
      {
        address: kase.address,
        chain: kase.chain,
        symbol: kase.symbol,
        isStockPaired: kase.chain === "robinhood",
        volume24hUsd: rolling[i],
        liquidityUsd: kase.liquidityUsd,
        priceChange24h:
          prevClose > 0 ? (candles[i].close / prevClose - 1) * 100 : undefined,
        volumeAccelRatio: rolling[i - 1] > 0 ? rolling[i] / rolling[i - 1] : undefined,
        volumeSpikeRatio: baseline > 0 ? rolling[i] / baseline : undefined,
      },
      config,
    );
    if (LEVEL_RANK[evaluation.level] >= LEVEL_RANK.alert) {
      alertHours++;
      if (firstAlertIdx == null) firstAlertIdx = i;
    }
  }

  const passed =
    kase.kind === "pump"
      ? firstAlertIdx != null && firstAlertIdx <= peakIdx
      : firstAlertIdx == null;

  return {
    passed,
    firstAlertAt:
      firstAlertIdx != null ? candles[firstAlertIdx].time_open : undefined,
    peakAt: candles[peakIdx]?.time_open ?? "",
    alertHours,
  };
}

async function fetchCaseCandles(
  chain: string,
  poolId: string,
  anchorAt: string,
  hoursBefore: number,
): Promise<OhlcvCandle[]> {
  const start = new Date(new Date(anchorAt).getTime() - hoursBefore * 3_600_000);
  // DexPaprika rate-limits aggressively; pace and retry once on 429.
  for (let attempt = 0; ; attempt++) {
    try {
      const candles = await fetchPoolOhlcv(poolId, {
        start: start.toISOString().slice(0, 10),
        interval: "1h",
        limit: 120,
        network: chain,
      });
      await sleep(600);
      return candles;
    } catch (err) {
      if (attempt === 0 && (err as Error).message.includes("429")) {
        await sleep(5_000);
        continue;
      }
      throw err;
    }
  }
}

/** Most-recent-first case library with candles attached (capped API cost). */
export async function buildCaseLibrary(
  labeled: LabeledOutcome[],
  missed: MissedCase[],
  maxCases = 30,
): Promise<ReviewCase[]> {
  const cases: ReviewCase[] = [];

  const sortedLabeled = [...labeled]
    .filter((l) => l.poolId && l.outcome !== "flat")
    .sort((a, b) => b.at.localeCompare(a.at));
  const sortedMissed = [...missed].sort((a, b) =>
    b.detectedAt.localeCompare(a.detectedAt),
  );

  for (const l of sortedLabeled) {
    if (cases.length >= maxCases) break;
    try {
      cases.push({
        kind: l.outcome === "win" ? "pump" : "control",
        source: l.outcome === "win" ? "win" : "loss",
        chain: l.chain,
        address: l.address,
        symbol: l.symbol,
        poolId: l.poolId!,
        anchorAt: l.at,
        liquidityUsd: l.liquidityUsd,
        candles: await fetchCaseCandles(l.chain, l.poolId!, l.at, 30),
      });
    } catch (err) {
      console.error(`case candles failed ${l.symbol}:`, (err as Error).message);
    }
  }

  for (const m of sortedMissed) {
    if (cases.length >= maxCases) break;
    try {
      cases.push({
        kind: "pump",
        source: "missed",
        chain: m.chain,
        address: m.address,
        symbol: m.symbol,
        poolId: m.poolId,
        anchorAt: m.detectedAt,
        liquidityUsd: m.liquidityUsd,
        candles: await fetchCaseCandles(m.chain, m.poolId, m.detectedAt, 54),
      });
    } catch (err) {
      console.error(`case candles failed ${m.symbol}:`, (err as Error).message);
    }
  }

  return cases.filter((c) => c.candles.length >= 30);
}
