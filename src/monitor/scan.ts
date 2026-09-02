import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeToken } from "../long/analyze-token.js";
import { collectLaunches } from "../long/fetch-launches.js";
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
import type { LaunchRecord, LaunchesPayload } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHES_PATH = path.resolve(__dirname, "../../data/launches.json");

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
  if (refresh) {
    const payload = await collectLaunches();
    return payload.launches;
  }
  try {
    const raw = await readFile(LAUNCHES_PATH, "utf8");
    const payload = JSON.parse(raw) as LaunchesPayload;
    return payload.launches;
  } catch {
    const payload = await collectLaunches();
    return payload.launches;
  }
}

function rankLaunches(launches: LaunchRecord[]): LaunchRecord[] {
  return [...launches].sort((a, b) => b.volume_24h - a.volume_24h);
}

export async function scanLaunches(options: ScanOptions = {}): Promise<ScanHit[]> {
  const minLevel = options.minLevel ?? "watch";
  const minRank = LEVEL_RANK[minLevel];
  const state = await loadMonitorState();
  const launches = rankLaunches(await loadLaunches(options.refreshLaunches ?? false));
  const limit = options.limit ?? launches.length;
  const hits: ScanHit[] = [];

  for (const launch of launches.slice(0, limit)) {
    try {
      const analysis = await analyzeToken(launch.address);
      const prev = state.tokens[launch.address.toLowerCase()];
      const accel =
        prev && prev.volume24hUsd > 0
          ? (analysis.volume24hUsd ?? 0) / prev.volume24hUsd
          : undefined;

      const input = analysisToSignalInput(analysis, {
        volumeAccelRatio: accel,
        dexUrl: launch.dex_url,
        longUrl: launch.long_url,
      });
      const evaluation = evaluateSignal(input);

      state.tokens[launch.address.toLowerCase()] = {
        volume24hUsd: input.volume24hUsd,
        level: evaluation.level,
        score: evaluation.score,
        updatedAt: new Date().toISOString(),
      };

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
