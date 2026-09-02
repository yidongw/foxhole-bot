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
import { enabledChains, type ChainId } from "../chains/adapter.js";
import { getAdapter } from "../chains/registry.js";
import {
  fetchFourmemeLaunches,
  formatFourmemeDigest,
  getBscLatestBlock,
} from "../chains/bsc/fourmeme.js";
import {
  fetchClankerLaunches,
  formatClankerDigest,
  getBaseLatestBlock,
} from "../chains/base/clanker.js";
import { loadTradeConfig } from "../trade/config.js";
import { managePositions, processSignals } from "../trade/engine.js";
import type { LaunchRecord, LaunchesPayload, TokenAnalysis } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHES_PATH = path.resolve(__dirname, "../../data/launches.json");
const SIGNALS_PATHS = [
  path.resolve(__dirname, "../../data/signals.json"),
  path.resolve(__dirname, "../../web/data/signals.json"),
];

/** Max trending candidates analyzed per non-Robinhood chain per tick. */
const TRENDING_LIMIT = 12;

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

export interface SignalRow {
  address: string;
  chain: string;
  symbol?: string;
  lock_ratio?: number;
  level: AlertLevel;
  score: number;
  triggers: string[];
  volume_24h: number;
  updated_at: string;
}

/** Monitor-state key. Robinhood keeps bare addresses for back-compat. */
function stateKey(chain: ChainId, address: string): string {
  const addr = address.toLowerCase();
  return chain === "robinhood" ? addr : `${chain}:${addr}`;
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
  // Persist so the dashboard stays fresh from the monitor loop alone.
  await writeLaunchesJson(payload).catch((err) =>
    console.error("failed to write launches.json:", (err as Error).message),
  );
  return payload.launches;
}

function rankLaunches(launches: LaunchRecord[]): LaunchRecord[] {
  return [...launches].sort((a, b) => b.volume_24h - a.volume_24h);
}

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

/** Shared dedup + delivery for one evaluated token. */
async function maybeAlert(
  state: MonitorState,
  evaluation: SignalEvaluation,
  key: string,
  prevLevel: AlertLevel | undefined,
  minRank: number,
  options: ScanOptions,
): Promise<ScanHit | undefined> {
  if (LEVEL_RANK[evaluation.level] < minRank) return undefined;

  const upgraded = isLevelUpgrade(prevLevel, evaluation.level);
  const canSend = shouldSendAlert(state, key, evaluation.level, evaluation.triggers);

  let sent = false;
  let skippedReason: string | undefined;
  if (!upgraded && !canSend) {
    skippedReason = "cooldown / no level upgrade";
  } else if (canSend) {
    await deliverAlert(formatSignalAlert(evaluation), options);
    sent = true;
    recordAlert(state, key, evaluation.level, evaluation.triggers);
  } else {
    skippedReason = "duplicate";
  }
  return { evaluation, sent, skippedReason };
}

function snapshotAndRow(
  state: MonitorState,
  key: string,
  analysis: TokenAnalysis,
  evaluation: SignalEvaluation,
  rows: SignalRow[],
): void {
  state.tokens[key] = {
    volume24hUsd: evaluation.input.volume24hUsd,
    lockRatio: analysis.quoteLockRatio,
    level: evaluation.level,
    score: evaluation.score,
    updatedAt: new Date().toISOString(),
  };
  rows.push({
    address: analysis.address,
    chain: analysis.chain ?? "robinhood",
    symbol: analysis.symbol,
    lock_ratio: analysis.quoteLockRatio,
    level: evaluation.level,
    score: evaluation.score,
    triggers: evaluation.triggers,
    volume_24h: evaluation.input.volume24hUsd,
    updated_at: new Date().toISOString(),
  });
}

/** Default first-run lookback ≈2.5h at ~100ms Robinhood Chain blocks. */
const FACTORY_FIRST_RUN_LOOKBACK = 90_000n;

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

async function scanRobinhood(
  state: MonitorState,
  options: ScanOptions,
  minRank: number,
  hits: ScanHit[],
  rows: SignalRow[],
): Promise<void> {
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

  for (const launch of launches.slice(0, limit)) {
    try {
      const analysis = await analyzeToken(launch.address);
      const key = stateKey("robinhood", launch.address);
      const prev = state.tokens[key];
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
      snapshotAndRow(state, key, analysis, evaluation, rows);

      const hit = await maybeAlert(state, evaluation, key, prev?.level, minRank, options);
      if (hit) hits.push(hit);
    } catch (err) {
      console.error(`scan failed ${launch.symbol} ${launch.address}:`, (err as Error).message);
    }
    await sleep(250);
  }
}

/** BSC first-run lookback ≈25 min at 0.75s blocks. */
const FOURMEME_FIRST_RUN_LOOKBACK = 2_000n;

async function checkFourmemeLaunches(
  state: MonitorState,
  options: ScanOptions,
): Promise<void> {
  const mode = process.env.LAUNCH_ALERT_MODE ?? "digest";
  const latest = await getBscLatestBlock();
  const from = state.lastFourmemeBlock
    ? BigInt(state.lastFourmemeBlock) + 1n
    : latest - FOURMEME_FIRST_RUN_LOOKBACK;
  if (from > latest) return;

  const launches = await fetchFourmemeLaunches(from, latest);
  if (launches.length && mode !== "off") {
    await deliverAlert(formatFourmemeDigest(launches), options);
  }
  state.lastFourmemeBlock = latest.toString();
  if (launches.length) {
    console.log(`fourmeme watcher: ${launches.length} new launch(es)`);
  }
}

/** Base first-run lookback ≈1h at 2s blocks. */
const CLANKER_FIRST_RUN_LOOKBACK = 1_800n;

async function checkClankerLaunches(
  state: MonitorState,
  options: ScanOptions,
): Promise<void> {
  const mode = process.env.LAUNCH_ALERT_MODE ?? "digest";
  const latest = await getBaseLatestBlock();
  const from = state.lastClankerBlock
    ? BigInt(state.lastClankerBlock) + 1n
    : latest - CLANKER_FIRST_RUN_LOOKBACK;
  if (from > latest) return;

  const launches = await fetchClankerLaunches(from, latest);
  if (launches.length && mode !== "off") {
    await deliverAlert(formatClankerDigest(launches), options);
  }
  state.lastClankerBlock = latest.toString();
  if (launches.length) {
    console.log(`clanker watcher: ${launches.length} new launch(es)`);
  }
}

async function scanChainTrending(
  chain: ChainId,
  state: MonitorState,
  options: ScanOptions,
  minRank: number,
  hits: ScanHit[],
  rows: SignalRow[],
): Promise<void> {
  if (chain === "bsc") {
    try {
      await checkFourmemeLaunches(state, options);
    } catch (err) {
      console.error("fourmeme watcher failed (continuing):", (err as Error).message);
    }
  }
  if (chain === "base") {
    try {
      await checkClankerLaunches(state, options);
    } catch (err) {
      console.error("clanker watcher failed (continuing):", (err as Error).message);
    }
  }

  const adapter = getAdapter(chain);
  let candidates: string[];
  try {
    candidates = (await adapter.trendingCandidates()).slice(0, TRENDING_LIMIT);
  } catch (err) {
    console.error(`${chain} trending failed:`, (err as Error).message);
    return;
  }

  for (const address of candidates) {
    try {
      const analysis = await adapter.analyze(address);
      const key = stateKey(chain, address);
      const prev = state.tokens[key];
      const accel =
        prev && prev.volume24hUsd > 0
          ? (analysis.volume24hUsd ?? 0) / prev.volume24hUsd
          : undefined;

      const input = analysisToSignalInput(analysis, {
        volumeAccelRatio: accel,
        isStockPaired: false,
        dexUrl: `https://dexscreener.com/${chain}/${address}`,
        longUrl: undefined,
      });
      const evaluation = evaluateSignal(input);
      snapshotAndRow(state, key, analysis, evaluation, rows);

      const hit = await maybeAlert(state, evaluation, key, prev?.level, minRank, options);
      if (hit) hits.push(hit);
    } catch (err) {
      console.error(`${chain} scan failed ${address}:`, (err as Error).message);
    }
    await sleep(250);
  }
}

/** One discovery pass over all enabled chains. */
export async function scanLaunches(options: ScanOptions = {}): Promise<ScanHit[]> {
  const minLevel = options.minLevel ?? "watch";
  const minRank = LEVEL_RANK[minLevel];
  const state = await loadMonitorState();
  const hits: ScanHit[] = [];
  const rows: SignalRow[] = [];
  const chains = enabledChains();

  if (chains.includes("robinhood")) {
    await scanRobinhood(state, options, minRank, hits, rows);
  }
  for (const chain of chains.filter((c) => c !== "robinhood")) {
    await scanChainTrending(chain, state, options, minRank, hits, rows);
  }

  state.lastRunAt = new Date().toISOString();
  await saveMonitorState(state);
  if (rows.length) {
    await writeSignalsJson(rows).catch((err) =>
      console.error("failed to write signals.json:", (err as Error).message),
    );
  }
  return hits;
}

export async function runMonitorLoop(options: ScanOptions & { once?: boolean }): Promise<void> {
  const interval = Number(process.env.POLL_INTERVAL_MS ?? SIGNAL_CONFIG.pollIntervalMs);
  const positionInterval = Number(process.env.POSITION_TICK_MS ?? 15_000);
  let consecutiveFailures = 0;
  let stopped = false;

  const discoveryTick = async () => {
    console.log(
      `[${new Date().toISOString()}] scanning chains: ${enabledChains().join(", ")}…`,
    );
    const hits = await scanLaunches({ ...options, refreshLaunches: true });
    const alerted = hits.filter((h) => h.sent);
    console.log(
      `done: ${hits.length} signals ≥${options.minLevel ?? "watch"}, ${alerted.length} alerts sent`,
    );

    const tradeConfig = loadTradeConfig();
    if (tradeConfig.mode !== "off") {
      await processSignals(
        hits.map((h) => h.evaluation),
        { dryRun: options.dryRun, webhookUrl: options.webhookUrl },
        tradeConfig,
      );
    }
  };

  // Fast loop: open positions get priced and exit-checked every ~15s —
  // 5-minute stops are far too slow for meme trailing exits.
  const positionLoop = async () => {
    while (!stopped) {
      try {
        const tradeConfig = loadTradeConfig();
        if (tradeConfig.mode !== "off") {
          await managePositions(
            { dryRun: options.dryRun, webhookUrl: options.webhookUrl },
            tradeConfig,
          );
        }
      } catch (err) {
        console.error("position tick error:", (err as Error).message);
      }
      await sleep(positionInterval);
    }
  };

  if (options.once) {
    await discoveryTick();
    const tradeConfig = loadTradeConfig();
    if (tradeConfig.mode !== "off") {
      await managePositions(
        { dryRun: options.dryRun, webhookUrl: options.webhookUrl },
        tradeConfig,
      );
    }
    return;
  }

  const positionLoopPromise = positionLoop();

  while (true) {
    try {
      await discoveryTick();
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
    const backoff =
      consecutiveFailures > 0
        ? Math.min(interval * 2 ** Math.min(consecutiveFailures, 4), 30 * 60_000)
        : interval;
    await sleep(backoff);
  }

  // Unreachable, but keeps the position loop referenced.
  stopped = true;
  await positionLoopPromise;
}
