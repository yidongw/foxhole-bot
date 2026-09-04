import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchTokenPairs } from "../dex/dexscreener.js";
import { fetchPaprikaTokenPriceUsd } from "../dex/dexpaprika.js";
import { selectDeepestBasePair } from "../chains/generic-analysis.js";
import { getAdapter, positionChain } from "../chains/registry.js";
import type { ChainId } from "../chains/adapter.js";
import { sendDiscordMessage } from "../notify/discord.js";
import { appendAlertLog } from "../notify/alert-log.js";
import { appendTradeJournal } from "./trade-journal.js";
import { resolveWebhook } from "../notify/routes.js";
import { postToSignalThread } from "../notify/signal-threads.js";
import { sleep } from "../lib/utils.js";
import { fdvTag, gmgnLink } from "../lib/format.js";
import type { SignalEvaluation } from "../signals/types.js";
import { loadTradeConfig, type TradeConfig } from "./config.js";
import {
  loadPositions,
  openPositions,
  paperCashUsd,
  recordExit,
  remainingFraction,
  mutatePositions,
  mergeExitIntoFresh,
  totalPnlUsd,
  realizedUsd,
  mergeStrategy,
  formatStrategy,
  type Position,
  type PositionStrategy,
  type PositionsFile,
} from "./positions.js";
import { checkEntry } from "./risk.js";
import { checkTokenSafety, safetyGateEnabled } from "./safety.js";
import { evaluateExits, type ExitAction } from "./exits.js";
import type { TradeFill } from "./execute.js";
import {
  ADVISOR_COOLDOWN_MS,
  adviseExit,
  advisorAvailable,
} from "./advisor.js";

export interface EngineOptions {
  dryRun?: boolean;
  webhookUrl?: string;
}

async function notify(
  body: string,
  options: EngineOptions,
  chain?: string,
  tokenAddress?: string,
): Promise<void> {
  if (options.dryRun) {
    console.log("--- DRY RUN TRADE ---\n" + body + "\n");
    return;
  }
  await appendAlertLog(body);
  // Trade events go to the (per-chain) 交易日志 channel when configured.
  const url = options.webhookUrl ?? resolveWebhook("trade", chain);
  if (url) await sendDiscordMessage(url, body).catch((err) => console.error(err));
  else console.log(body);
  // Mirror into the token's signal thread so 交易思考全在一处
  if (chain && tokenAddress) {
    await postToSignalThread(chain, tokenAddress, body).catch(() => {});
  }
}

function modeTag(config: TradeConfig): string {
  return config.mode === "paper" ? "📝 PAPER" : "💸 LIVE";
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSITIONS_WEB_PATH = path.resolve(__dirname, "../../web/data/positions.json");
const PAUSE_FLAG_PATH = path.resolve(__dirname, "../../data/trading-paused");

/** Pause blocks NEW entries only — exits and stops keep running. */
export function tradingPaused(): boolean {
  return existsSync(PAUSE_FLAG_PATH);
}

export async function setTradingPaused(paused: boolean): Promise<void> {
  if (paused) {
    await mkdir(path.dirname(PAUSE_FLAG_PATH), { recursive: true });
    await writeFile(PAUSE_FLAG_PATH, new Date().toISOString(), "utf8");
  } else {
    await rm(PAUSE_FLAG_PATH, { force: true });
  }
}

function matchesPosition(p: Position, query: string): boolean {
  const q = query.toLowerCase();
  return (
    p.token.toLowerCase() === q ||
    (p.symbol ?? "").toLowerCase() === q
  );
}

/**
 * Corroborate an adapter price that lands absurdly far from the position's own
 * high-water mark, in EITHER direction. The exit loop already guards downside
 * bad ticks (see the glitch guard below); upside ones are just as damaging on a
 * manual exit: MarsCoin (real price $0.1224, high-water $0.1379) read back as
 * $149.29, which booked $25k of phantom paper proceeds AND poisoned the
 * high-water mark, so the trail stop immediately liquidated the rest. Returns
 * the corroborated price, or undefined when nothing confirms the read.
 */
async function corroboratePrice(
  position: Position,
  chain: ChainId,
  price: number,
): Promise<number | undefined> {
  if (price > position.highWaterUsd * 0.35 && price < position.highWaterUsd * 5) return price;
  let confirm: number | undefined;
  try {
    const p2 = selectDeepestBasePair(
      await fetchTokenPairs(position.token, chain),
      position.token,
    );
    if (p2?.priceUsd) confirm = Number(p2.priceUsd);
  } catch {}
  if (confirm == null || confirm <= 0) {
    try {
      confirm = await fetchPaprikaTokenPriceUsd(chain, position.token);
    } catch {}
  }
  if (confirm == null || confirm <= 0) return undefined;
  // A second source that agrees within the same band vindicates the read; one
  // that disagrees means the adapter tick was garbage — trust the second read.
  return confirm;
}

/**
 * Manually exit `fraction` (0..1] of an open position by symbol or address.
 * Sells at the position's own mode (paper stays paper). Returns a human
 * summary for the control surface.
 */
export async function manualExit(query: string, fraction = 1): Promise<string> {
  const file = await loadPositions();
  const position = openPositions(file).find((p) => matchesPosition(p, query));
  if (!position) return `No open position matching "${query}".`;

  const chain = positionChain(position.chain);
  const raw = await getAdapter(chain).priceUsd(position.token);
  if (!raw || raw <= 0) return `No price available for ${position.symbol} — try again.`;
  const price = await corroboratePrice(position, chain, raw);
  if (!price) {
    return `Exit skipped for ${position.symbol}: price $${raw} is far off high-water $${position.highWaterUsd} and no second source could confirm it — try again.`;
  }
  let fdvUsd: number | undefined;
  try {
    fdvUsd = selectDeepestBasePair(
      await fetchTokenPairs(position.token, chain),
      position.token,
    )?.fdv;
  } catch {}

  const sellFraction = Math.min(Math.max(fraction, 0), 1) * remainingFraction(position);
  const config = { ...loadTradeConfig(), mode: position.mode };
  try {
    // Slow work (chain sell in live mode) stays outside the ledger lock; the
    // exit is then merged into FRESH state so a concurrent engine tick can't
    // resurrect the position with a stale save (pussy 2026-09-04).
    const fill = await executeSell(chain, config, position, sellFraction, price);
    const exit = {
      at: new Date().toISOString(),
      priceUsd: fill.priceUsd,
      fraction: sellFraction,
      proceedsUsd: fill.proceedsUsd ?? 0,
      reason: "manual exit",
      txHash: fill.txHash,
    };
    const { file: freshFile, result: freshPos } = await mutatePositions((f) => {
      const fp = f.positions.find((p) => p.id === position.id);
      if (!fp || fp.status !== "open") return undefined;
      mergeExitIntoFresh(fp, exit);
      fp.highWaterUsd = Math.max(fp.highWaterUsd, price);
      return fp;
    });
    if (!freshPos) {
      return `Exit skipped for ${position.symbol}: position already closed by another writer.`;
    }
    const positionFresh = freshPos;
    await writePositionsJson(freshFile, { [position.token.toLowerCase()]: price });
    position.status = positionFresh.status;
    position.exits = positionFresh.exits;
    const pnl = totalPnlUsd(positionFresh, price);
    await appendTradeJournal(
      `📤 手动平仓 ${position.symbol} [${chain}/${position.mode}] 卖出 ${(sellFraction * 100).toFixed(0)}% @ $${fill.priceUsd.toPrecision(4)} → $${(fill.proceedsUsd ?? 0).toFixed(2)}${fdvTag(fdvUsd)} | 持仓盈亏 ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | 策略: ${formatStrategy(position.strategy)}`,
    );
    return (
      `Sold ${(sellFraction * 100).toFixed(0)}% of ${position.symbol} [${chain}/${position.mode}] ` +
      `@ $${fill.priceUsd.toPrecision(4)} → $${(fill.proceedsUsd ?? 0).toFixed(2)}${fdvTag(fdvUsd)}. ` +
      `Position P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${position.status}).`
    );
  } catch (err) {
    return `Exit failed for ${position.symbol}: ${(err as Error).message}`;
  }
}

/**
 * AI-decided entry. Same gates as automatic entries (risk caps, dup checks,
 * safety incl. chart) — the AI chooses token/size/timing but cannot bypass
 * any control. Size is clamped to the per-trade cap.
 */
export async function aiBuy(
  chainId: string,
  address: string,
  usd: number,
  reason: string,
  opts?: { smartMoney?: boolean; momentum?: boolean; strategy?: PositionStrategy },
): Promise<string> {
  const chain = positionChain(chainId);
  const config = loadTradeConfig();
  if (config.mode === "off") return "交易未开启 (TRADE_MODE=off)";
  if (tradingPaused()) return "交易已暂停 (/resume 恢复)";

  const analysis = await getAdapter(chain).analyze(address);
  const triggers = ["ai_decision"];
  if (opts?.smartMoney) triggers.push("smart_money");
  if (opts?.momentum) triggers.push("momentum_strong");
  const candidate = {
    token: analysis.address,
    chain,
    symbol: analysis.symbol,
    priceUsd: analysis.priceUsd,
    liquidityUsd: analysis.liquidityUsd ?? 0,
    triggers,
  };

  const file = await loadPositions();
  // 2026-09-04 用户拆除预算类限制:单笔 $50/$25 夹子取消,买多少由 AI 判断。
  // 唯一保留的是账本现金(paper 不许透支;live 由链上余额天然约束)——这是
  // 记账完整性,不是策略限制。止损/安全门(防骗子合约)不属于预算,原样保留。
  const cash =
    config.mode === "paper" ? paperCashUsd(file, config.paperStartUsd) : Infinity;
  const clamped = Math.min(usd, cash);
  if (!(clamped > 0)) return `风控拒绝: 可用现金不足 ($${cash.toFixed(2)})`;
  const verdict = checkEntry({ ...config, usdPerTrade: clamped }, file, candidate);
  if (!verdict.ok) return `风控拒绝: ${verdict.reason}`;

  if (safetyGateEnabled()) {
    const safety = await checkTokenSafety(chain, address, analysis.primaryPairAddress);
    if (!safety.ok) {
      await appendTradeJournal(
        `🛑 AI买入被安全门否决 ${candidate.symbol} [${chain}] — ${safety.flags.join(", ")}`,
      );
      return `安全门否决: ${safety.flags.join(", ")}`;
    }
  }

  const fill = await executeBuy(chain, config, address, candidate.priceUsd!, clamped);
  const position: Position = {
    id: `${address.toLowerCase()}-${Date.now()}`,
    mode: config.mode,
    chain,
    token: analysis.address,
    symbol: analysis.symbol,
    trigger: `ai_decision: ${reason}`.slice(0, 200),
    openedAt: new Date().toISOString(),
    entryPriceUsd: fill.priceUsd,
    amountTokens: fill.amountTokens,
    costUsd: clamped,
    highWaterUsd: fill.priceUsd,
    exits: [],
    status: "open",
    txHash: fill.txHash,
  };
  // Per-position exit plan set at entry (falls back to config where unset).
  if (opts?.strategy) mergeStrategy(position, opts.strategy);
  // Push under the ledger lock with a FRESH cash re-check — the advisory check
  // above ran on a snapshot that may be minutes stale (MarsCoin's $60 buy was
  // eaten by exactly this race on 2026-09-04).
  const { file: freshFile, result: ok } = await mutatePositions((f) => {
    const freshCash =
      config.mode === "paper" ? paperCashUsd(f, config.paperStartUsd) : Infinity;
    if (freshCash < clamped) return false;
    f.positions.push(position);
    return true;
  });
  if (!ok) return `风控拒绝: 可用现金不足（并发核算后）`;
  await writePositionsJson(freshFile);
  const strat = formatStrategy(position.strategy);
  await appendTradeJournal(
    `📥 AI开仓 ${position.symbol} [${chain}/${config.mode}] $${clamped} @ $${fill.priceUsd.toPrecision(4)} (${fill.amountTokens.toFixed(2)} 枚) — 理由: ${reason} | 策略: ${strat}${fill.txHash ? ` tx:${fill.txHash}` : ""}`,
  );
  const link = gmgnLink(chain, position.token);
  await notify(
    `🤖 ${modeTag(config)} 🟢 买入 **${position.symbol}** [${chain}]${fdvTag(analysis.fdvUsd)}\n` +
      `$${clamped.toFixed(2)} @ $${fill.priceUsd.toPrecision(6)} (${fill.amountTokens.toFixed(2)} 枚)\n` +
      `理由: ${reason}\n策略: ${strat}${link ? `\n${link}` : ""}${fill.txHash ? `\nTx: ${fill.txHash}` : ""}`,
    {},
    chain,
    position.token,
  );
  return `✅ 已开仓 ${position.symbol} [${chain}/${config.mode}] $${clamped} @ $${fill.priceUsd.toPrecision(4)} (${fill.amountTokens.toFixed(2)} 枚) | 策略: ${strat}`;
}

/**
 * Set or adjust an open position's exit strategy (per-position rails). The AI
 * calls this at buy time via a fresh plan and later to re-tune as the position
 * develops — a de-risked runner can widen its trail, a broken thesis can
 * tighten its stop. Fields left out keep their current value; only supplied
 * fields change. Returns a human summary for the control surface / thread.
 */
export async function setStrategy(
  query: string,
  patch: PositionStrategy,
): Promise<string> {
  const { file, result: position } = await mutatePositions((f) => {
    const fp = openPositions(f).find((p) => matchesPosition(p, query));
    if (fp) mergeStrategy(fp, patch);
    return fp;
  });
  if (!position) return `No open position matching "${query}".`;
  await writePositionsJson(file);
  const chain = positionChain(position.chain);
  const summary = formatStrategy(position.strategy);
  await appendTradeJournal(
    `🎯 调整策略 ${position.symbol} [${chain}/${position.mode}] — ${summary}`,
  );
  await postToSignalThread(chain, position.token, `🎯 策略更新: ${summary}`).catch(() => {});
  return `Strategy for ${position.symbol} [${chain}/${position.mode}]: ${summary}`;
}

export async function exitAllPositions(): Promise<string> {
  const file = await loadPositions();
  const open = openPositions(file);
  if (!open.length) return "No open positions.";
  const lines: string[] = [];
  for (const p of open) {
    lines.push(await manualExit(p.token, 1));
  }
  return lines.join("\n");
}

/** Dashboard snapshot; `marks` carries the freshest prices from this tick. */
async function writePositionsJson(
  file: PositionsFile,
  marks: Record<string, number> = {},
): Promise<void> {
  const rows = file.positions.slice(-50).map((p) => {
    const mark = marks[p.token.toLowerCase()];
    return {
      chain: p.chain ?? "robinhood",
      symbol: p.symbol,
      token: p.token,
      mode: p.mode,
      status: p.status,
      trigger: p.trigger,
      opened_at: p.openedAt,
      closed_at: p.closedAt,
      entry_price_usd: p.entryPriceUsd,
      current_price_usd: mark,
      remaining_fraction: remainingFraction(p),
      cost_usd: p.costUsd,
      pnl_usd: totalPnlUsd(p, mark),
      strategy: p.strategy ? formatStrategy(p.strategy) : undefined,
      amount_tokens: p.amountTokens,
      high_water_usd: p.highWaterUsd,
      // Full exit timeline so the dashboard can draw the realized equity
      // curve and per-trade breakdowns client-side.
      exits: p.exits.map((e) => ({
        at: e.at,
        price_usd: e.priceUsd,
        fraction: e.fraction,
        proceeds_usd: e.proceedsUsd,
        reason: e.reason,
      })),
    };
  });
  const payload = JSON.stringify(
    {
      meta: {
        updated_at: new Date().toISOString(),
        count: rows.length,
        start_usd: loadTradeConfig().paperStartUsd,
      },
      positions: rows,
    },
    null,
    2,
  );
  await mkdir(path.dirname(POSITIONS_WEB_PATH), { recursive: true });
  await writeFile(POSITIONS_WEB_PATH, payload, "utf8").catch((err) =>
    console.error("failed to write positions.json:", (err as Error).message),
  );
}

/** Paper fills happen here; live fills route to the chain adapter. */
async function executeBuy(
  chain: ChainId,
  config: TradeConfig,
  token: string,
  priceUsd: number,
  usd: number,
): Promise<TradeFill> {
  if (config.mode === "paper") {
    return { priceUsd, amountTokens: usd / priceUsd };
  }
  const adapter = getAdapter(chain);
  if (!adapter.buy) {
    throw new Error(`live execution not implemented on ${chain}`);
  }
  return adapter.buy(token, priceUsd, usd, config);
}

async function executeSell(
  chain: ChainId,
  config: TradeConfig,
  position: Position,
  fraction: number,
  currentPriceUsd: number,
): Promise<TradeFill> {
  if (config.mode === "paper") {
    const amountTokens = position.amountTokens * fraction;
    return {
      priceUsd: currentPriceUsd,
      amountTokens,
      proceedsUsd: amountTokens * currentPriceUsd,
    };
  }
  const adapter = getAdapter(chain);
  if (!adapter.sell) {
    throw new Error(`live execution not implemented on ${chain}`);
  }
  return adapter.sell(position, fraction, currentPriceUsd, config);
}

/** Attempt entries for qualifying signal evaluations. */
export async function processSignals(
  evaluations: SignalEvaluation[],
  options: EngineOptions = {},
  config: TradeConfig = loadTradeConfig(),
): Promise<Position[]> {
  if (config.mode === "off") return [];
  if (!config.autoEntry) {
    // AI decider owns entries — mechanical auto-entry would override its
    // skip decisions (it bought "I" 1 min after the decider said skip).
    return [];
  }
  if (tradingPaused()) {
    console.log("trading paused — skipping entries (exits still active)");
    return [];
  }
  const file = await loadPositions();
  const opened: Position[] = [];

  for (const ev of evaluations) {
    const chain = (ev.input.chain ?? "robinhood") as ChainId;
    const candidate = {
      token: ev.input.address,
      chain,
      symbol: ev.input.symbol,
      priceUsd: ev.input.priceUsd,
      liquidityUsd: ev.input.liquidityUsd,
      triggers: ev.triggers,
    };
    const verdict = checkEntry(config, file, candidate);
    if (!verdict.ok) {
      if (verdict.reason !== "no qualifying entry trigger") {
        console.log(`entry skipped ${ev.input.symbol}: ${verdict.reason}`);
      }
      continue;
    }

    if (safetyGateEnabled()) {
      const safety = await checkTokenSafety(
        chain,
        candidate.token,
        ev.input.primaryPairAddress,
      );
      if (!safety.ok) {
        console.log(
          `entry vetoed ${ev.input.symbol} [${chain}]: ${safety.flags.join(", ")}`,
        );
        await appendTradeJournal(
          `🛑 否决入场 ${ev.input.symbol} [${chain}] — ${safety.flags.join(", ")} (triggers: ${ev.triggers.join(",")})`,
        );
        await notify(
          `🛑 ${modeTag(config)} entry VETOED [${chain}] ${candidate.symbol}: ${safety.flags.join(", ")}` +
            (gmgnLink(chain, candidate.token) ? `\n${gmgnLink(chain, candidate.token)}` : ""),
          options,
          chain,
          candidate.token,
        );
        continue;
      }
    }

    try {
      const fill = await executeBuy(
        chain,
        config,
        candidate.token,
        candidate.priceUsd!,
        config.usdPerTrade,
      );
      const position: Position = {
        id: `${candidate.token.toLowerCase()}-${Date.now()}`,
        mode: config.mode,
        chain,
        token: candidate.token,
        symbol: candidate.symbol,
        trigger: ev.triggers.join(","),
        openedAt: new Date().toISOString(),
        entryPriceUsd: fill.priceUsd,
        amountTokens: fill.amountTokens,
        costUsd: config.usdPerTrade,
        highWaterUsd: fill.priceUsd,
        exits: [],
        status: "open",
        txHash: fill.txHash,
      };
      file.positions.push(position);
      opened.push(position);
      await appendTradeJournal(
        `📥 开仓 ${position.symbol} [${chain}/${config.mode}] $${config.usdPerTrade} @ $${fill.priceUsd.toPrecision(4)} (${fill.amountTokens.toFixed(2)} 枚) — 触发: ${position.trigger} | 策略: ${formatStrategy(position.strategy)}${fill.txHash ? ` tx:${fill.txHash}` : ""}`,
      );
      await notify(
        [
          `${modeTag(config)} 🟢 买入 **${position.symbol ?? position.token}** [${chain}]${fdvTag(ev.input.fdvUsd)}`,
          `$${config.usdPerTrade.toFixed(2)} @ $${fill.priceUsd.toPrecision(6)} (${fill.amountTokens.toFixed(2)} 枚)`,
          `触发: ${position.trigger}`,
          `策略: ${formatStrategy(position.strategy)}`,
          gmgnLink(chain, position.token),
          fill.txHash ? `Tx: ${fill.txHash}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        options,
        chain,
        position.token,
      );
    } catch (err) {
      console.error(`entry failed ${candidate.symbol}:`, (err as Error).message);
      await notify(
        `⚠️ ${modeTag(config)} entry FAILED for ${candidate.symbol}: ${(err as Error).message}` +
          (gmgnLink(chain, candidate.token) ? `\n${gmgnLink(chain, candidate.token)}` : ""),
        options,
        chain,
        candidate.token,
      );
    }
  }

  if (opened.length) {
    // New entries merge into FRESH ledger state under the lock — a plain save
    // of our snapshot would erase any exits recorded by other writers while
    // this (slow, price-fetching) scan ran.
    const { file: freshFile } = await mutatePositions((f) => {
      f.positions.push(...opened);
    });
    await writePositionsJson(freshFile);
  }
  return opened;
}

/** Refresh prices for open positions, update high-water marks, run exits. */
export async function managePositions(
  options: EngineOptions = {},
  config: TradeConfig = loadTradeConfig(),
): Promise<void> {
  if (config.mode === "off") return;
  const file = await loadPositions();
  const open = openPositions(file);
  // Snapshot each position's exit count so only THIS tick's exits are replayed
  // onto fresh ledger state at the end — the tick is slow (per-position price
  // fetches, minutes under 429 storms) and a whole-file save of this stale
  // snapshot kept clobbering concurrent CLI trades (2026-09-04 ×3).
  const exitCountBefore = new Map(open.map((p) => [p.id, p.exits.length]));
  if (!open.length) return;
  const marks: Record<string, number> = {};

  for (const position of open) {
    const chain = positionChain(position.chain);
    let price: number | undefined;
    let volume24hUsd: number | undefined;
    let priceChange24h: number | undefined;
    let fdvUsd: number | undefined;
    try {
      const pairs = await fetchTokenPairs(position.token, chain);
      const primary = selectDeepestBasePair(pairs, position.token);
      if (primary?.priceUsd) price = Number(primary.priceUsd);
      volume24hUsd = Number(primary?.volume?.h24 ?? 0) || undefined;
      priceChange24h = primary?.priceChange?.h24;
      fdvUsd = primary?.fdv;
    } catch (err) {
      console.error(`price fetch failed ${position.symbol}:`, (err as Error).message);
    }
    if (price == null || price <= 0) {
      // DexScreener outage must not blind the stops — fall back to DexPaprika.
      try {
        price = await fetchPaprikaTokenPriceUsd(chain, position.token);
        if (price) console.log(`using DexPaprika fallback price for ${position.symbol}`);
      } catch {}
    }
    if (price == null || price <= 0) continue;

    // Glitch guard: a >65% single-tick collapse below the high-water mark is
    // almost always a bad read (a degraded DexScreener response drops the deep
    // pair's liquidity to null→0, so a thin wrong-pair with a garbage price
    // ranks first), not real action on a token that had real liquidity. No
    // configured stop is that deep, so this can only be noise or a true rug —
    // and both deserve a second look before we market-sell the whole position.
    // memestock was hard-stopped at $0.0077 (140x below its $1.08 entry, −$139)
    // on ONE garbage tick while the real price never left ~$1. Corroborate with
    // a fresh read; a genuine rug still exits one tick (~15s) later once the low
    // price is confirmed, but a transient glitch no longer liquidates the book.
    if (price < position.highWaterUsd * 0.35) {
      let confirm: number | undefined;
      try {
        const p2 = selectDeepestBasePair(
          await fetchTokenPairs(position.token, chain),
          position.token,
        );
        if (p2?.priceUsd) confirm = Number(p2.priceUsd);
      } catch {}
      if (confirm == null || confirm <= 0) {
        try {
          confirm = await fetchPaprikaTokenPriceUsd(chain, position.token);
        } catch {}
      }
      if (confirm != null && confirm > position.highWaterUsd * 0.35) {
        console.error(
          `glitch guard: ${position.symbol} bad tick $${price} vs confirm $${confirm} ` +
            `(hw $${position.highWaterUsd}) — skipping exit this tick`,
        );
        marks[position.token.toLowerCase()] = confirm;
        continue;
      }
      if (confirm != null && confirm > 0) price = confirm; // corroborated read
    }

    // Same guard, upside: a >5x single-tick jump above the high-water mark is a
    // bad read too, and it is worse than a bad low one because Math.max below
    // burns it into highWaterUsd permanently — every trail stop from then on is
    // measured off a price the token never traded at.
    if (price > position.highWaterUsd * 5) {
      const confirm = await corroboratePrice(position, chain, price);
      if (confirm != null && confirm > 0 && confirm <= position.highWaterUsd * 5) {
        console.error(
          `glitch guard: ${position.symbol} bad high tick $${price} vs confirm $${confirm} ` +
            `(hw $${position.highWaterUsd}) — using confirmed price`,
        );
        price = confirm;
      }
    }

    marks[position.token.toLowerCase()] = price;

    position.highWaterUsd = Math.max(position.highWaterUsd, price);
    const actions: ExitAction[] = evaluateExits(position, price, config);

    // Optional LLM advisor: may recommend an EARLY exit when the deterministic
    // rails haven't fired; it can never cancel or delay them.
    if (
      !actions.length &&
      advisorAvailable() &&
      (!position.lastAdvisorAt ||
        Date.now() - new Date(position.lastAdvisorAt).getTime() >
          ADVISOR_COOLDOWN_MS)
    ) {
      position.lastAdvisorAt = new Date().toISOString();
      const decision = await adviseExit(position, {
        currentPriceUsd: price,
        volume24hUsd,
        priceChange24h,
      });
      if (decision.action === "exit" && decision.confidence >= 0.6) {
        actions.push({
          fraction: remainingFraction(position),
          reason: `advisor (${decision.confidence.toFixed(2)}): ${decision.reason}`,
        });
      }
    }

    for (const action of actions) {
      try {
        const fill = await executeSell(chain, config, position, action.fraction, price);
        recordExit(position, {
          at: new Date().toISOString(),
          priceUsd: fill.priceUsd,
          fraction: action.fraction,
          proceedsUsd: fill.proceedsUsd ?? 0,
          reason: action.reason,
          txHash: fill.txHash,
        });
        const pnl = totalPnlUsd(position, price);
        await appendTradeJournal(
          `📤 平仓 ${position.symbol} [${chain}/${config.mode}] 卖出 ${(action.fraction * 100).toFixed(0)}% @ $${fill.priceUsd.toPrecision(4)} → $${(fill.proceedsUsd ?? 0).toFixed(2)} — 原因: ${action.reason} | 持仓盈亏 ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${position.status}) | 策略: ${formatStrategy(position.strategy)}`,
        );
        await notify(
          [
            `${modeTag(config)} 📤 **${position.symbol ?? position.token}** [${chain}] — ${action.reason}`,
            `平 ${(action.fraction * 100).toFixed(0)}% @ $${fill.priceUsd.toPrecision(6)} → $${(fill.proceedsUsd ?? 0).toFixed(2)}${fdvTag(fdvUsd)}`,
            `仓位盈亏 ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${position.status})`,
            `策略: ${formatStrategy(position.strategy)}`,
            gmgnLink(chain, position.token),
            fill.txHash ? `Tx: ${fill.txHash}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          options,
          chain,
          position.token,
        );
      } catch (err) {
        console.error(`exit failed ${position.symbol}:`, (err as Error).message);
      }
    }
    await sleep(250);
  }

  // Replay this tick's deltas (high-water, advisor timestamps, new exits)
  // onto FRESH ledger state under the lock. Exits computed against our
  // snapshot are clamped to what actually remains — if a CLI sell landed
  // mid-tick, we neither resurrect the position nor double-sell it.
  const dayMs = 24 * 60 * 60 * 1000;
  const { file: freshFile, result: dueDailyReport } = await mutatePositions(
    (fresh) => {
      for (const position of open) {
        const fp = fresh.positions.find((p) => p.id === position.id);
        if (!fp) continue;
        fp.highWaterUsd = Math.max(fp.highWaterUsd, position.highWaterUsd);
        if (position.lastAdvisorAt) fp.lastAdvisorAt = position.lastAdvisorAt;
        const newExits = position.exits.slice(exitCountBefore.get(position.id) ?? 0);
        for (const e of newExits) {
          if (fp.status !== "open") break;
          mergeExitIntoFresh(fp, e);
        }
      }
      const due =
        fresh.positions.length > 0 &&
        (!fresh.lastReportAt ||
          Date.now() - new Date(fresh.lastReportAt).getTime() > dayMs);
      if (due) fresh.lastReportAt = new Date().toISOString();
      return due;
    },
  );
  await writePositionsJson(freshFile, marks);

  if (dueDailyReport) {
    await notify(`📊 **现货 Daily P&L**\n${await formatPortfolioReport()}`, options);
  }
}

export async function formatPortfolioReport(): Promise<string> {
  const file = await loadPositions();
  const config = loadTradeConfig();
  const start = config.paperStartUsd;
  const cash = paperCashUsd(file, start);

  // 措辞/结构对齐永续 formatPerpReport,两条 trade-log 消息长得一样。
  const lines: string[] = [];
  const open = openPositions(file);
  let openValue = 0;
  if (open.length) {
    lines.push(`**现货持仓 (${open.length})**`);
    for (const p of open) {
      const chain = positionChain(p.chain);
      let price: number | undefined;
      let fdvUsd: number | undefined;
      try {
        const primary = selectDeepestBasePair(await fetchTokenPairs(p.token, chain), p.token);
        if (primary?.priceUsd) price = Number(primary.priceUsd);
        fdvUsd = primary?.fdv;
      } catch {}
      if (price == null) {
        try {
          price = await getAdapter(chain).priceUsd(p.token);
        } catch {}
      }
      const pnl = totalPnlUsd(p, price);
      const rem = remainingFraction(p);
      openValue += rem * p.amountTokens * (price ?? p.entryPriceUsd);
      lines.push(
        `• 🟢 ${p.symbol ?? p.token} [${chain}/${p.mode}] ${(rem * 100).toFixed(0)}% 剩, ` +
          `开 $${p.entryPriceUsd.toPrecision(6)}${price ? ` 现 $${price.toPrecision(6)}` : ""}${fdvTag(fdvUsd)}, ` +
          `盈亏 ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` +
          (p.strategy ? `\n    ↳ 策略: ${formatStrategy(p.strategy)}` : ""),
      );
      await sleep(200);
    }
  } else {
    lines.push("无现货持仓");
  }

  const closed = file.positions.filter((p) => p.status === "closed");
  if (closed.length) {
    const realized = closed.reduce((s, p) => s + realizedUsd(p) - p.costUsd, 0);
    lines.push(
      `**已平: ${closed.length} 笔, 已实现盈亏 ${realized >= 0 ? "+" : ""}$${realized.toFixed(2)}**`,
    );
  }

  // Paper account balance — the number the strategy is judged against.
  const equity = cash + openValue;
  const pnl = equity - start;
  const pct = (pnl / start) * 100;
  lines.push(
    `**💰 现货账户(${config.mode}) $${equity.toFixed(2)}** ` +
      `(起始 $${start.toFixed(0)} · ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} / ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%) — ` +
      `可用现金 $${cash.toFixed(2)}${openValue > 0 ? ` · 持仓市值 $${openValue.toFixed(2)}` : ""}`,
  );
  return lines.join("\n");
}
