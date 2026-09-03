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
import { SIGNAL_CONFIG, loadSignalConfig } from "../signals/config.js";
import type { AlertLevel, SignalEvaluation } from "../signals/types.js";
import { LEVEL_RANK } from "../signals/types.js";
import { sendDiscordMessage } from "../notify/discord.js";
import { appendAlertLog } from "../notify/alert-log.js";
import { recordAlertOutcome } from "../review/ledger.js";
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
  addFourmemeProbation,
  fetchFourmemeLaunches,
  formatFourmemeDigest,
  getBscLatestBlock,
  loadFourmemeWatch,
  nearGradFourmemeCandidates,
  saveFourmemeWatch,
  screenFourmemeProbation,
} from "../chains/bsc/fourmeme.js";
import {
  fetchClankerLaunches,
  formatClankerDigest,
  getBaseLatestBlock,
} from "../chains/base/clanker.js";
import {
  fetchNewWethPairs,
  formatEthPairDigest,
  getEthLatestBlock,
} from "../chains/ethereum/uniswap-watcher.js";
import {
  addPumpProbation,
  fetchRecentPumpLaunches,
  formatPumpLaunchDigest,
  loadPumpWatch,
  nearGradCandidates,
  savePumpWatch,
  screenPumpProbation,
} from "../chains/solana/pumpfun-launches.js";
import { loadTradeConfig } from "../trade/config.js";
import { checkTokenSafety } from "../trade/safety.js";
import { resolveWebhook } from "../notify/routes.js";
import { appendAiInbox } from "../notify/ai-inbox.js";
import { maybeSpawnDecider } from "../trade/decider.js";
import { postThreadedSignal } from "../notify/signal-threads.js";
import { diffStockRegistry, newlyListedQuote } from "../chains/robinhood/stock-watch.js";
import { postNewStock } from "../notify/stock-threads.js";
import {
  fetchNewV4PoolTokens,
  getV4LatestBlock,
  loadV4Watch,
  saveV4Watch,
  screenProbation,
} from "../chains/robinhood/v4-watcher.js";
import { managePositions, processSignals } from "../trade/engine.js";
import { managePerpPositions } from "../venues/hyperliquid/engine.js";
import { loadHlConfig } from "../venues/hyperliquid/config.js";
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

/**
 * #trade-signal 语义: 每条消息 = 触发交易。只有满足开仓条件的信号
 * (strong + pre-pump 入场触发器 + 通过安全门) 才走这里。
 */
async function deliverTradeSignal(
  body: string,
  options: Pick<ScanOptions, "dryRun" | "webhookUrl">,
  chain?: string,
): Promise<void> {
  if (options.dryRun) {
    console.log("--- DRY RUN TRADE SIGNAL ---\n" + body + "\n");
    return;
  }
  await appendAlertLog(body);
  const url = options.webhookUrl ?? resolveWebhook("signal", chain);
  if (url) await sendDiscordMessage(url, body);
  else console.log(body);
}

/**
 * 信息流 (launch digests, watch/alert 级、动量追认型 strong): 默认不上
 * Discord — 记入 alerts.json + 日志, 仪表盘可见。想看流水可配
 * DISCORD_FEED_WEBHOOK_URL 单独频道。
 */
async function deliverFeed(
  body: string,
  options: Pick<ScanOptions, "dryRun" | "webhookUrl">,
  chain?: string,
): Promise<void> {
  if (options.dryRun) {
    console.log("--- DRY RUN FEED ---\n" + body + "\n");
    return;
  }
  await appendAlertLog(body);
  const url = resolveWebhook("feed", chain);
  if (url) await sendDiscordMessage(url, body);
  else console.log(body);
}

/** Entry-grade = same bar as opening a position: strong + pre-pump trigger. */
function isTradeGrade(evaluation: SignalEvaluation): boolean {
  if (evaluation.level !== "strong") return false;
  const entryTriggers = loadTradeConfig().entryTriggers;
  return evaluation.triggers.some((t) => entryTriggers.includes(t));
}

const GMGN_CHAIN: Record<string, string> = {
  solana: "sol",
  bsc: "bsc",
  base: "base",
  ethereum: "eth",
};

function formatTradeSignal(ev: SignalEvaluation): string {
  const i = ev.input;
  const chain = i.chain ?? "robinhood";
  const links: string[] = [];
  links.push(
    `📈 <https://dexscreener.com/${chain}/${i.primaryPairAddress ?? i.address}>`,
  );
  if (GMGN_CHAIN[chain]) {
    links.push(`🔍 <https://gmgn.ai/${GMGN_CHAIN[chain]}/token/${i.address}>`);
  }
  if (i.primaryPairAddress) {
    links.push(
      `🦎 <https://www.geckoterminal.com/${chain === "ethereum" ? "eth" : chain}/pools/${i.primaryPairAddress}>`,
    );
  }
  if (chain === "robinhood") {
    links.push(`🔗 <https://robinhoodchain.blockscout.com/token/${i.address}>`);
  }
  return [
    "🎯 **交易触发 / TRADE SIGNAL**",
    formatSignalAlert(ev),
    `CA: \`${i.address}\``,
    links.join("  "),
  ].join("\n");
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
    if (isTradeGrade(evaluation)) {
      // Trade-grade must ALSO clear the safety gate before pinging the
      // user — a signal that the engine would veto is not a trade trigger.
      const input = evaluation.input;
      // ② Gate 0: a meme that clears the trade-grade bar AND pairs a
      // freshly-listed official stock token is the squeeze-play footprint —
      // badge it and bump to strong so it stands out among the day's signals.
      if (input.isStockPaired) {
        const fresh = await newlyListedQuote(input.quoteSymbol).catch(() => undefined);
        if (fresh) {
          const age = fresh.ageDays < 1 ? "今日" : `${Math.floor(fresh.ageDays)}d 前`;
          const badge = `⭐ 底池新股 ${input.quoteSymbol}（${age}上榜官方股票）`;
          if (!evaluation.reasons.includes(badge)) evaluation.reasons.unshift(badge);
          if (!evaluation.triggers.includes("new_stock_quote")) {
            evaluation.triggers.unshift("new_stock_quote");
          }
          evaluation.level = "strong";
        }
      }
      const safety = await checkTokenSafety(
        input.chain ?? "robinhood",
        input.address,
        input.primaryPairAddress,
        // Pre-graduation curve tokens (four.meme / pump.fun) have no AMM OHLCV
        // yet, so the chart check must not veto them for "no history".
        { onBondingCurve: input.curveProgress != null && !input.curveGraduated },
      );
      if (safety.ok) {
        // Thread-per-token mode (card + thread); flat message as fallback
        const threaded = options.dryRun
          ? false
          : await postThreadedSignal(evaluation);
        if (!threaded) {
          await deliverTradeSignal(formatTradeSignal(evaluation), options, input.chain);
        } else {
          await appendAlertLog(formatTradeSignal(evaluation));
        }
        // Wake the AI decision layer: inbox entry + headless decider spawn
        // (session probes die with their session — the monitor owns the wake)
        if (!options.dryRun) {
          await appendAiInbox(evaluation).catch((err) =>
            console.error("ai inbox write failed:", (err as Error).message),
          );
          void maybeSpawnDecider("signal");
        }
      } else {
        await deliverFeed(
          `⛔ 信号被安全门拦截 ${input.symbol} [${input.chain}]: ${safety.flags.join(", ")}\n` +
            formatSignalAlert(evaluation),
          options,
          input.chain,
        );
        skippedReason = `safety veto: ${safety.flags.join(",")}`;
      }
    } else {
      await deliverFeed(formatSignalAlert(evaluation), options, evaluation.input.chain);
    }
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
  // Alert-level signals feed the outcome ledger even when delivery is
  // cooldown-suppressed — the review grades signal quality, not delivery.
  recordAlertOutcome(analysis, evaluation).catch((err) =>
    console.error("outcome record failed:", (err as Error).message),
  );
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
        await deliverFeed(formatLaunchAlert(event), options, "robinhood");
      }
    } else if (events.length && mode === "digest") {
      await deliverFeed(formatLaunchDigest(events), options, "robinhood");
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
      const evaluation = evaluateSignal(input, loadSignalConfig());
      snapshotAndRow(state, key, analysis, evaluation, rows);

      const hit = await maybeAlert(state, evaluation, key, prev?.level, minRank, options);
      if (hit) hits.push(hit);
    } catch (err) {
      console.error(`scan failed ${launch.symbol} ${launch.address}:`, (err as Error).message);
    }
    await sleep(250);
  }
}

/** RB v4 watcher first-run lookback ≈50 min at ~100ms blocks. */
const V4_FIRST_RUN_LOOKBACK = 30_000n;

/**
 * RB 通用 v4 新池监控 (JINQIAN 教训): 新池的非 quote 币进观察名单,
 * DexScreener 索引且流动性达标后每 tick 跟踪分析 12h。
 */
async function checkV4NewPools(state: MonitorState): Promise<void> {
  const latest = await getV4LatestBlock();
  const from = state.lastV4Block
    ? BigInt(state.lastV4Block) + 1n
    : latest - V4_FIRST_RUN_LOOKBACK;
  if (from > latest) return;

  const tokens = await fetchNewV4PoolTokens(from, latest);
  state.lastV4Block = latest.toString();
  if (!tokens.length) return;

  const entries = await loadV4Watch();
  const seen = new Set(entries.map((e) => e.address.toLowerCase()));
  let added = 0;
  for (const addr of tokens) {
    if (seen.has(addr.toLowerCase())) continue;
    entries.push({
      address: addr,
      firstSeen: new Date().toISOString(),
      verified: false,
      attempts: 0,
    });
    added++;
  }
  if (added) {
    await saveV4Watch(entries);
    console.log(`v4 watcher: ${added} new pool token(s) on probation`);
  }
}

async function scanV4Watch(
  state: MonitorState,
  options: ScanOptions,
  minRank: number,
  hits: ScanHit[],
  rows: SignalRow[],
): Promise<void> {
  const entries = await loadV4Watch();
  if (!entries.length) return;

  // Cheap batch screening promotes liquid probation tokens to verified
  const promoted = await screenProbation(entries);
  if (promoted) console.log(`v4 watcher: ${promoted} token(s) verified — tracking`);

  for (const entry of entries.filter((e) => e.verified)) {
    try {
      const analysis = await analyzeToken(entry.address);
      const key = stateKey("robinhood", entry.address);
      const prev = state.tokens[key];
      const accel =
        prev && prev.volume24hUsd > 0
          ? (analysis.volume24hUsd ?? 0) / prev.volume24hUsd
          : undefined;
      const input = analysisToSignalInput(analysis, {
        volumeAccelRatio: accel,
        dexUrl: `https://dexscreener.com/robinhood/${entry.address}`,
      });
      const evaluation = evaluateSignal(input, loadSignalConfig());
      snapshotAndRow(state, key, analysis, evaluation, rows);
      const hit = await maybeAlert(state, evaluation, key, prev?.level, minRank, options);
      if (hit) hits.push(hit);
    } catch {
      entry.attempts++;
    }
    await sleep(250);
  }
  await saveV4Watch(entries);
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
    await deliverFeed(formatFourmemeDigest(launches), options, "bsc");
  }
  state.lastFourmemeBlock = latest.toString();
  if (launches.length) {
    // Track every mint on probation so the ones that graduate to a real
    // PancakeSwap pool get analyzed + signal-graded (the squeeze moment) —
    // symmetric to the RB v4-watcher, not just a fire-and-forget digest.
    const entries = await loadFourmemeWatch();
    const added = await addFourmemeProbation(launches, entries);
    if (added) await saveFourmemeWatch(entries);
    console.log(
      `fourmeme watcher: ${launches.length} new launch(es), ${added} on probation`,
    );
  }
}

/**
 * Screen probation four.meme tokens, then analyze + signal-grade each tick:
 *  - verified (graduated, DexScreener-liquid) tokens, and
 *  - the top near-graduation probation tokens still on the bonding curve —
 *    the only window where `curve_near_grad_strong` (a BSC trade-grade entry
 *    trigger) can fire, since post-graduation it's disabled and the trending
 *    feed only ever surfaces already-graduated tokens.
 * The BSC analogue of scanV4Watch / scanPumpWatch.
 */
async function scanFourmemeWatch(
  state: MonitorState,
  options: ScanOptions,
  minRank: number,
  hits: ScanHit[],
  rows: SignalRow[],
): Promise<void> {
  const entries = await loadFourmemeWatch();
  if (!entries.length) return;

  const promoted = await screenFourmemeProbation(entries);
  if (promoted) {
    console.log(`fourmeme watcher: ${promoted} token(s) verified — tracking`);
  }

  const adapter = getAdapter("bsc");
  // Verified (post-graduation) + near-graduation on-curve candidates. Dedup by
  // address so a token promoted this tick isn't analyzed twice.
  const targets = [
    ...entries.filter((e) => e.verified),
    ...nearGradFourmemeCandidates(entries),
  ];
  const seen = new Set<string>();
  for (const entry of targets) {
    if (seen.has(entry.address.toLowerCase())) continue;
    seen.add(entry.address.toLowerCase());
    try {
      // adapter.analyze reads the four.meme curve on-chain, so graduation and
      // curve-progress signals are populated authoritatively here.
      const analysis = await adapter.analyze(entry.address);
      const key = stateKey("bsc", entry.address);
      const prev = state.tokens[key];
      const accel =
        prev && prev.volume24hUsd > 0
          ? (analysis.volume24hUsd ?? 0) / prev.volume24hUsd
          : undefined;
      const input = analysisToSignalInput(analysis, {
        volumeAccelRatio: accel,
        isStockPaired: false,
        dexUrl: `https://dexscreener.com/bsc/${entry.address}`,
      });
      const evaluation = evaluateSignal(input, loadSignalConfig());
      snapshotAndRow(state, key, analysis, evaluation, rows);
      const hit = await maybeAlert(state, evaluation, key, prev?.level, minRank, options);
      if (hit) hits.push(hit);
    } catch {
      entry.attempts++;
    }
    await sleep(250);
  }
  await saveFourmemeWatch(entries);
}

/** Solana first-run lookback for pump.fun launches (30 min). */
const PUMP_FIRST_RUN_LOOKBACK_MS = 30 * 60_000;

async function checkPumpLaunches(
  state: MonitorState,
  options: ScanOptions,
): Promise<void> {
  const mode = process.env.LAUNCH_ALERT_MODE ?? "digest";
  const since =
    state.lastPumpLaunchAt ?? Date.now() - PUMP_FIRST_RUN_LOOKBACK_MS;

  const launches = await fetchRecentPumpLaunches(since);
  if (launches.length && mode !== "off") {
    await deliverFeed(formatPumpLaunchDigest(launches), options, "solana");
  }
  // Advance the cursor to the newest launch seen this pass (or keep it if none).
  state.lastPumpLaunchAt = launches.reduce(
    (max, l) => Math.max(max, l.createdAt),
    state.lastPumpLaunchAt ?? since,
  );
  if (launches.length) {
    // Track every fresh mint on probation so the ones that graduate to a real
    // PumpSwap/Raydium pool get analyzed + signal-graded (the squeeze moment) —
    // symmetric to the four.meme watcher, not just a fire-and-forget digest.
    const entries = await loadPumpWatch();
    const added = addPumpProbation(launches, entries);
    if (added) await savePumpWatch(entries);
    console.log(
      `pump.fun watcher: ${launches.length} new launch(es), ${added} on probation`,
    );
  }
}

/**
 * Screen probation pump.fun tokens, then analyze + signal-grade each tick:
 *  - verified (graduated, DexScreener-liquid) tokens, and
 *  - the top near-graduation probation tokens still on the bonding curve —
 *    the only window where `curve_near_grad_strong` (the Solana trade-grade
 *    entry trigger) can fire, since post-graduation it's disabled and the
 *    trending feed only ever surfaces already-graduated tokens.
 * The Solana analogue of scanFourmemeWatch.
 */
async function scanPumpWatch(
  state: MonitorState,
  options: ScanOptions,
  minRank: number,
  hits: ScanHit[],
  rows: SignalRow[],
): Promise<void> {
  const entries = await loadPumpWatch();
  if (!entries.length) return;

  const promoted = await screenPumpProbation(entries);
  if (promoted) {
    console.log(`pump.fun watcher: ${promoted} token(s) verified — tracking`);
  }

  const adapter = getAdapter("solana");
  // Verified (post-graduation) + near-graduation on-curve candidates. Dedup by
  // address so a token promoted this tick isn't analyzed twice.
  const targets = [...entries.filter((e) => e.verified), ...nearGradCandidates(entries)];
  const seen = new Set<string>();
  for (const entry of targets) {
    if (seen.has(entry.address.toLowerCase())) continue;
    seen.add(entry.address.toLowerCase());
    try {
      const analysis = await adapter.analyze(entry.address);
      const key = stateKey("solana", entry.address);
      const prev = state.tokens[key];
      const accel =
        prev && prev.volume24hUsd > 0
          ? (analysis.volume24hUsd ?? 0) / prev.volume24hUsd
          : undefined;
      const input = analysisToSignalInput(analysis, {
        volumeAccelRatio: accel,
        isStockPaired: false,
        dexUrl: `https://dexscreener.com/solana/${entry.address}`,
      });
      const evaluation = evaluateSignal(input, loadSignalConfig());
      snapshotAndRow(state, key, analysis, evaluation, rows);
      const hit = await maybeAlert(state, evaluation, key, prev?.level, minRank, options);
      if (hit) hits.push(hit);
    } catch {
      entry.attempts++;
    }
    await sleep(250);
  }
  await savePumpWatch(entries);
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
    await deliverFeed(formatClankerDigest(launches), options, "base");
  }
  state.lastClankerBlock = latest.toString();
  if (launches.length) {
    console.log(`clanker watcher: ${launches.length} new launch(es)`);
  }
}

/** ETH first-run lookback ≈4h at 12s blocks. */
const UNISWAP_FIRST_RUN_LOOKBACK = 1_200n;

async function checkEthNewPairs(
  state: MonitorState,
  options: ScanOptions,
): Promise<void> {
  const mode = process.env.LAUNCH_ALERT_MODE ?? "digest";
  const latest = await getEthLatestBlock();
  const from = state.lastUniswapBlock
    ? BigInt(state.lastUniswapBlock) + 1n
    : latest - UNISWAP_FIRST_RUN_LOOKBACK;
  if (from > latest) return;

  const pairs = await fetchNewWethPairs(from, latest);
  if (pairs.length && mode !== "off") {
    await deliverFeed(await formatEthPairDigest(pairs), options, "ethereum");
  }
  state.lastUniswapBlock = latest.toString();
  if (pairs.length) {
    console.log(`uniswap watcher: ${pairs.length} new WETH pair(s)`);
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
      await scanFourmemeWatch(state, options, minRank, hits, rows);
    } catch (err) {
      console.error("fourmeme watcher failed (continuing):", (err as Error).message);
    }
  }
  if (chain === "solana") {
    try {
      await checkPumpLaunches(state, options);
      await scanPumpWatch(state, options, minRank, hits, rows);
    } catch (err) {
      console.error("pump.fun watcher failed (continuing):", (err as Error).message);
    }
  }
  if (chain === "base") {
    try {
      await checkClankerLaunches(state, options);
    } catch (err) {
      console.error("clanker watcher failed (continuing):", (err as Error).message);
    }
  }
  if (chain === "ethereum") {
    try {
      await checkEthNewPairs(state, options);
    } catch (err) {
      console.error("uniswap watcher failed (continuing):", (err as Error).message);
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

      // On Robinhood, trending tokens can be stock-paired memes (JINQIAN/FAMI)
      // — keep analyzeToken's stock-pair detection so lock/launch signals
      // work; other chains have no stock pairing.
      const input = analysisToSignalInput(analysis, {
        volumeAccelRatio: accel,
        ...(chain === "robinhood" ? {} : { isStockPaired: false }),
        dexUrl: `https://dexscreener.com/${chain}/${address}`,
        longUrl: undefined,
      });
      const evaluation = evaluateSignal(input, loadSignalConfig());
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
    // Dynamic discovery for RB too (boosts + top movers): catches non-Long
    // memes outside the stock-keyword search — the JINQIAN lesson (+700%
    // missed because FAMI wasn't in SEARCH_QUERIES and the token never
    // touched the Long factory).
    await scanChainTrending("robinhood", state, options, minRank, hits, rows);
    // Structural fix for the same lesson: watch EVERY new v4 pool at
    // creation so non-Long memes are seen the second they launch.
    try {
      await checkV4NewPools(state);
      await scanV4Watch(state, options, minRank, hits, rows);
    } catch (err) {
      console.error("v4 watcher failed (continuing):", (err as Error).message);
    }
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
  const stockInterval = Number(process.env.STOCK_POLL_MS ?? 15_000);
  let consecutiveFailures = 0;
  let stopped = false;

  // New official RH stock listings — the earliest footprint of the tokenized-
  // stock squeeze play (the meme can't pair a real stock token until the stock
  // is minted here). Its own fast loop (~15s, the RH API's server-cache floor)
  // so a fresh listing surfaces promptly; the first run seeds silently.
  const stockTick = async () => {
    if (!enabledChains().includes("robinhood")) return;
    const { newStocks, bootstrap } = await diffStockRegistry();
    if (bootstrap) {
      console.log("stock registry: seeded snapshot (first run)");
    } else if (newStocks.length) {
      console.log(
        `stock registry: ${newStocks.length} new listing(s): ${newStocks.map((s) => s.symbol).join(", ")}`,
      );
      if (!options.dryRun) {
        for (const stock of newStocks) await postNewStock(stock);
      }
    }
  };
  const stockLoop = async () => {
    while (!stopped) {
      try {
        await stockTick();
      } catch (err) {
        console.error("stock registry watch error:", (err as Error).message);
      }
      await sleep(stockInterval);
    }
  };

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

    // Daily self-review: grade alerts, hunt missed 暴涨, auto-tune (gated).
    // Disabled via DISABLE_INTERNAL_REVIEW=1 when an external driver (the 2h
    // Discord-scheduled全链 review) is the sole review authority — avoids the
    // two processes racing on pending-movers.json / double-posting.
    try {
      const state = await loadMonitorState();
      const dayMs = 24 * 60 * 60 * 1000;
      if (
        process.env.DISABLE_INTERNAL_REVIEW !== "1" &&
        (!state.lastReviewAt || Date.now() - new Date(state.lastReviewAt).getTime() > dayMs)
      ) {
        state.lastReviewAt = new Date().toISOString();
        await saveMonitorState(state);
        const { runDailyReview } = await import("../review/daily.js");
        await runDailyReview({ dryRun: options.dryRun, webhookUrl: options.webhookUrl });
      }
    } catch (err) {
      console.error("daily review failed (continuing):", (err as Error).message);
    }
  };

  // News loop: BlockBeats 快讯轮询 — 上所催化/RB链动态/关注币负面 → 叫醒。
  // Gated on BLOCKBEATS_NEWS (default on); scrape-based until we hold an API key.
  const newsInterval = Number(process.env.NEWS_POLL_MS ?? 180_000);
  const newsLoop = async () => {
    if (process.env.BLOCKBEATS_NEWS === "0") return;
    const { newsTick } = await import("../news/poll.js");
    while (!stopped) {
      try {
        const r = await newsTick({ dryRun: options.dryRun, webhookUrl: options.webhookUrl });
        if (r.fetched) {
          console.log(`news tick: ${r.fetched} flashes, ${r.woke} woke, ${r.noted} noted`);
        }
      } catch (err) {
        console.error("news tick error:", (err as Error).message);
      }
      await sleep(newsInterval);
    }
  };

  // 6551 / OpenNews loop: AI-scored news+twitter(meme) directional signals →
  // #news-radar. Off unless OPENNEWS_TOKEN is set (free tier has tight quota),
  // so it stays a supplement to the BlockBeats radar. OPENNEWS_WATCH=0 forces off.
  const openNewsInterval = Number(process.env.OPENNEWS_POLL_MS ?? 600_000);
  const openNewsLoop = async () => {
    if (process.env.OPENNEWS_WATCH === "0") return;
    if (!process.env.OPENNEWS_TOKEN) return; // free tier is mostly neutral — opt-in only
    const { openNewsTick } = await import("../news/opennews-poll.js");
    while (!stopped) {
      try {
        const r = await openNewsTick({ dryRun: options.dryRun, webhookUrl: options.webhookUrl });
        if (r.posted) console.log(`opennews tick: ${r.fetched} scored, ${r.posted} posted`);
      } catch (err) {
        console.error("opennews tick error:", (err as Error).message);
      }
      await sleep(openNewsInterval);
    }
  };

  // OI 异动扫描(币安公开数据 → 妖币启动信号 → 永续做多/做空)。默认关(OI_SCAN=1 开)。
  const oiLoop = async () => {
    if (process.env.OI_SCAN !== "1") return;
    const oiInterval = Number(process.env.OI_SCAN_MS ?? 180_000);
    const { scanOiAnomalies } = await import("../signals/oi-anomaly.js");
    const { appendAiInboxPerp } = await import("../notify/ai-inbox.js");
    while (!stopped) {
      try {
        const hits = await scanOiAnomalies();
        for (const { metrics, verdict } of hits) {
          await appendAiInboxPerp({
            source: "oi-anomaly",
            symbol: metrics.base,
            side: verdict.side,
            score: verdict.score,
            metrics: {
              oiValueUsd: metrics.oiValueUsd,
              oiRisePct: metrics.oiRisePct,
              topTraderLong: metrics.topTraderLong,
              whaleCostBasis: metrics.whaleCostBasis,
              lastPrice: metrics.lastPrice,
              priceChg24h: metrics.priceChgPctWindow,
              fundingRate: metrics.fundingRate,
            },
            reasons: verdict.reasons,
          });
        }
        if (hits.length) {
          console.log(`oi scan: ${hits.length} anomaly hit(s) → inbox`);
          void maybeSpawnDecider("oi");
        }
      } catch (err) {
        console.error("oi scan error:", (err as Error).message);
      }
      await sleep(oiInterval);
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
        // 永续仓位同频托管止损止盈(HL_MODE=off 时内部直接返回)。
        const hlConfig = loadHlConfig();
        if (hlConfig.mode !== "off") {
          await managePerpPositions(hlConfig);
        }
      } catch (err) {
        console.error("position tick error:", (err as Error).message);
      }
      await sleep(positionInterval);
    }
  };

  if (options.once) {
    await stockTick().catch((err) =>
      console.error("stock registry watch error:", (err as Error).message),
    );
    await discoveryTick();
    const tradeConfig = loadTradeConfig();
    if (tradeConfig.mode !== "off") {
      await managePositions(
        { dryRun: options.dryRun, webhookUrl: options.webhookUrl },
        tradeConfig,
      );
    }
    const hlConfig = loadHlConfig();
    if (hlConfig.mode !== "off") {
      await managePerpPositions(hlConfig);
    }
    return;
  }

  // Interactive control surface (no-op without DISCORD_BOT_TOKEN)
  const { startControlBot } = await import("../notify/control-bot.js");
  startControlBot().catch((err) =>
    console.error("control bot failed to start:", (err as Error).message),
  );

  // Smart-money watchers (idle until wallets are added; SMART_MONEY=0 disables).
  //  - RB chain: on-chain wss/poll watcher (sub-second).
  //  - bsc/sol/base/eth: GMGN portfolio-activity poller.
  if (!options.dryRun) {
    const { startSmartMoneyWatcher } = await import(
      "../chains/robinhood/smart-money-watcher.js"
    );
    startSmartMoneyWatcher().catch((err) =>
      console.error("smart-money RB watcher failed to start:", (err as Error).message),
    );
    const { startActivityWatcher } = await import(
      "../smartmoney/activity-watcher.js"
    );
    startActivityWatcher().catch((err) =>
      console.error("smart-money activity watcher failed to start:", (err as Error).message),
    );
    const { startCieloWatcher } = await import("../smartmoney/cielo.js");
    startCieloWatcher().catch((err) =>
      console.error("smart-money cielo watcher failed to start:", (err as Error).message),
    );
    const { startDashboardWriter } = await import("../smartmoney/dashboard.js");
    startDashboardWriter().catch((err) =>
      console.error("smart-money dashboard writer failed to start:", (err as Error).message),
    );
  }

  const positionLoopPromise = positionLoop();
  const newsLoopPromise = newsLoop();
  void newsLoopPromise;
  const openNewsLoopPromise = openNewsLoop();
  void openNewsLoopPromise;
  const oiLoopPromise = oiLoop();
  void oiLoopPromise;
  const stockLoopPromise = stockLoop();
  void stockLoopPromise;

  while (true) {
    try {
      await discoveryTick();
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      console.error(`monitor tick error (${consecutiveFailures} in a row):`, err);
      if (consecutiveFailures === 3) {
        // Ops warning — main webhook (filter-log channel removed)
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
