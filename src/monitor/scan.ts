import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeToken } from "../long/analyze-token.js";
import { collectLaunches, writeLaunchesJson } from "../long/fetch-launches.js";
import {
  analysisToSignalInput,
  evaluateSignal,
  formatSignalAlert,
} from "../signals/evaluate.js";
import { SIGNAL_CONFIG } from "../signals/config.js";
import type { AlertLevel, SignalEvaluation } from "../signals/types.js";
import { LEVEL_RANK } from "../signals/types.js";
import { sendDiscordMessage } from "../notify/discord.js";
import {
  isLevelUpgrade,
  loadMonitorState,
  recordAlert,
  saveMonitorState,
  shouldSendAlert,
  type MonitorState,
} from "./state.js";
import { sleep } from "../lib/utils.js";
import {
  fetchCreatedEvents,
  formatLaunchAlert,
  getLatestBlock,
  type FactoryLaunch,
} from "../long/factory-watcher.js";
import { loadTradeConfig } from "../trade/config.js";
import { managePositions, processSignals } from "../trade/engine.js";
import type { LaunchRecord, LaunchesPayload } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHES_PATH = path.resolve(__dirname, "../../data/launches.json");
const SIGNALS_PATHS = [
  path.resolve(__dirname, "../../data/signals.json"),
  path.resolve(__dirname, "../../web/data/signals.json"),
];

export interface SignalRow {
  address: string;
  symbol?: string;
  lock_ratio?: number;
  level: AlertLevel;
  score: number;
  triggers: string[];
  volume_24h: number;
  updated_at: string;
}

async function writeSignalsJson(rows: SignalRow[]): Promise<void> {
  const payload = JSON.stringify(
    { meta: { updated_at: new Date().toISOString(), count: rows.length }, signals: rows },
    null,
    2,
  );
  for (const target of SIGNALS_PATHS) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, payload, "utf8");
  }
}

export interface ScanOptions {
  minLevel?: AlertLevel;
  refreshLaunches?: boolean;
  limit?: number;
  dryRun?: boolean;
  webhookUrl?: string;
}

export interface ScanHit {
  evaluation: SignalEvaluation;
  sent: boolean;
  skippedReason?: string;
}

async function loadLaunches(refresh: boolean): Promise<LaunchRecord[]> {
  if (!refresh) {
    try {
      const raw = await readFile(LAUNCHES_PATH, "utf8");
      const payload = JSON.parse(raw) as LaunchesPayload;
      return payload.launches;
    } catch {
      // fall through to a fresh fetch
    }
  }
  const payload = await collectLaunches();
  // Persist so the dashboard stays fresh from the monitor loop alone,
  // without needing a redeploy.
  await writeLaunchesJson(payload).catch((err) =>
    console.error("failed to write launches.json:", (err as Error).message),
  );
  return payload.launches;
}

function rankLaunches(launches: LaunchRecord[]): LaunchRecord[] {
  return [...launches].sort((a, b) => b.volume_24h - a.volume_24h);
}

/** Default first-run lookback ≈2.5h at ~100ms Robinhood Chain blocks. */
const FACTORY_FIRST_RUN_LOOKBACK = 90_000n;

async function deliverAlert(
  body: string,
  options: Pick<ScanOptions, "dryRun" | "webhookUrl">,
): Promise<void> {
  if (options.dryRun) {
    console.log("--- DRY RUN ALERT ---\n" + body + "\n");
    return;
  }
  const url = options.webhookUrl ?? process.env.DISCORD_WEBHOOK_URL;
  if (url) await sendDiscordMessage(url, body);
  else console.log(body);
}

function formatLaunchDigest(events: FactoryLaunch[]): string {
  const stockPaired = events.filter(
    (e) => e.pairSymbol && e.pairSymbol !== "USDG",
  );
  const sample = stockPaired.slice(0, 8).map((e) => `${e.symbol}/${e.pairSymbol}`);
  const lines = [
    `🚀 **Long.xyz launches**: ${events.length} new (${stockPaired.length} stock-paired)`,
  ];
  if (sample.length) lines.push(sample.join(", "));
  return lines.join("\n");
}

/**
 * Check the Long Factory for new Created events since the last scanned block —
 * catches every launch, including pairs DexScreener doesn't index yet.
 *
 * Launch volume is high (~2-3k/day observed), so the default alert mode is a
 * single digest message per tick. Set LAUNCH_ALERT_MODE=each for individual
 * alerts, or =off to only track without alerting.
 */
export async function checkFactoryLaunches(
  state: MonitorState,
  options: Pick<ScanOptions, "dryRun" | "webhookUrl"> = {},
): Promise<FactoryLaunch[]> {
  const mode = process.env.LAUNCH_ALERT_MODE ?? "digest";
  const latest = await getLatestBlock();
  const from = state.lastFactoryBlock
    ? BigInt(state.lastFactoryBlock) + 1n
    : latest - FACTORY_FIRST_RUN_LOOKBACK;

  let events: FactoryLaunch[] = [];
  if (from <= latest) {
    events = await fetchCreatedEvents({ fromBlock: from, toBlock: latest });
    if (events.length && mode === "each") {
      for (const event of events) {
        await deliverAlert(formatLaunchAlert(event), options);
      }
    } else if (events.length && mode === "digest") {
      await deliverAlert(formatLaunchDigest(events), options);
    }
    state.lastFactoryBlock = latest.toString();
  }
  return events;
}

export async function scanLaunches(options: ScanOptions = {}): Promise<ScanHit[]> {
  const minLevel = options.minLevel ?? "watch";
  const minRank = LEVEL_RANK[minLevel];
  const state = await loadMonitorState();

  try {
    const fresh = await checkFactoryLaunches(state, options);
    if (fresh.length) {
      console.log(`factory watcher: ${fresh.length} new launch(es) alerted`);
    }
  } catch (err) {
    console.error("factory watcher failed (continuing):", (err as Error).message);
  }

  const launches = rankLaunches(await loadLaunches(options.refreshLaunches ?? false));
  const limit = options.limit ?? launches.length;
  const hits: ScanHit[] = [];
  const signalRows: SignalRow[] = [];

  for (const launch of launches.slice(0, limit)) {
    try {
      const analysis = await analyzeToken(launch.address);
      const prev = state.tokens[launch.address.toLowerCase()];
      const accel =
        prev && prev.volume24hUsd > 0
          ? (analysis.volume24hUsd ?? 0) / prev.volume24hUsd
          : undefined;
      const lockDelta =
        prev?.lockRatio != null && analysis.quoteLockRatio != null
          ? analysis.quoteLockRatio - prev.lockRatio
          : undefined;

      const input = analysisToSignalInput(analysis, {
        volumeAccelRatio: accel,
        quoteLockDelta: lockDelta,
        dexUrl: launch.dex_url,
        longUrl: launch.long_url,
      });
      const evaluation = evaluateSignal(input);

      state.tokens[launch.address.toLowerCase()] = {
        volume24hUsd: input.volume24hUsd,
        lockRatio: analysis.quoteLockRatio,
        level: evaluation.level,
        score: evaluation.score,
        updatedAt: new Date().toISOString(),
      };

      signalRows.push({
        address: launch.address,
        symbol: launch.symbol,
        lock_ratio: analysis.quoteLockRatio,
        level: evaluation.level,
        score: evaluation.score,
        triggers: evaluation.triggers,
        volume_24h: input.volume24hUsd,
        updated_at: new Date().toISOString(),
      });

      if (LEVEL_RANK[evaluation.level] < minRank) continue;

      const upgraded = isLevelUpgrade(prev?.level, evaluation.level);
      const canSend = shouldSendAlert(
        state,
        launch.address,
        evaluation.level,
        evaluation.triggers,
      );

      let sent = false;
      let skippedReason: string | undefined;

      if (!upgraded && !canSend) {
        skippedReason = "cooldown / no level upgrade";
      } else if (canSend) {
        const body = formatSignalAlert(evaluation);
        if (options.dryRun) {
          console.log("--- DRY RUN ALERT ---\n" + body + "\n");
          sent = true;
        } else {
          const url = options.webhookUrl ?? process.env.DISCORD_WEBHOOK_URL;
          if (url) {
            await sendDiscordMessage(url, body);
            sent = true;
          } else {
            console.log(body);
            sent = true;
          }
        }
        recordAlert(state, launch.address, evaluation.level, evaluation.triggers);
      } else {
        skippedReason = "duplicate";
      }

      hits.push({ evaluation, sent, skippedReason });
    } catch (err) {
      console.error(`scan failed ${launch.symbol} ${launch.address}:`, (err as Error).message);
    }
    await sleep(250);
  }

  state.lastRunAt = new Date().toISOString();
  await saveMonitorState(state);
  if (signalRows.length) {
    await writeSignalsJson(signalRows).catch((err) =>
      console.error("failed to write signals.json:", (err as Error).message),
    );
  }
  return hits;
}

export async function runMonitorLoop(options: ScanOptions & { once?: boolean }): Promise<void> {
  const interval = Number(process.env.POLL_INTERVAL_MS ?? SIGNAL_CONFIG.pollIntervalMs);
  let consecutiveFailures = 0;

  const tick = async () => {
    console.log(`[${new Date().toISOString()}] scanning Long.xyz launches…`);
    const hits = await scanLaunches({ ...options, refreshLaunches: true });
    const alerted = hits.filter((h) => h.sent);
    console.log(`done: ${hits.length} signals ≥${options.minLevel ?? "watch"}, ${alerted.length} alerts sent`);

    const tradeConfig = loadTradeConfig();
    if (tradeConfig.mode !== "off") {
      const engineOptions = { dryRun: options.dryRun, webhookUrl: options.webhookUrl };
      await processSignals(hits.map((h) => h.evaluation), engineOptions, tradeConfig);
      await managePositions(engineOptions, tradeConfig);
    }
  };

  // Sequential loop (not setInterval): a slow scan must finish before the
  // next one starts, otherwise ticks overlap and double-alert.
  while (true) {
    try {
      await tick();
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      console.error(`monitor tick error (${consecutiveFailures} in a row):`, err);
      if (consecutiveFailures === 3) {
        const url = options.webhookUrl ?? process.env.DISCORD_WEBHOOK_URL;
        if (url && !options.dryRun) {
          await sendDiscordMessage(
            url,
            `⚠️ **FOXHOLE MONITOR** unhealthy — 3 consecutive scan failures. Last error: ${(err as Error).message}`,
          ).catch(() => {});
        }
      }
    }
    if (options.once) return;
    const backoff =
      consecutiveFailures > 0
        ? Math.min(interval * 2 ** Math.min(consecutiveFailures, 4), 30 * 60_000)
        : interval;
    await sleep(backoff);
  }
}
