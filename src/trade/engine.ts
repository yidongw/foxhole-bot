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
import { fdvTag } from "../lib/format.js";
import type { SignalEvaluation } from "../signals/types.js";
import { loadTradeConfig, type TradeConfig } from "./config.js";
import {
  loadPositions,
  openPositions,
  paperCashUsd,
  recordExit,
  remainingFraction,
  savePositions,
  totalPnlUsd,
  realizedUsd,
  type Position,
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
 * Manually exit `fraction` (0..1] of an open position by symbol or address.
 * Sells at the position's own mode (paper stays paper). Returns a human
 * summary for the control surface.
 */
export async function manualExit(query: string, fraction = 1): Promise<string> {
  const file = await loadPositions();
  const position = openPositions(file).find((p) => matchesPosition(p, query));
  if (!position) return `No open position matching "${query}".`;

  const chain = positionChain(position.chain);
  const price = await getAdapter(chain).priceUsd(position.token);
  if (!price || price <= 0) return `No price available for ${position.symbol} — try again.`;

  const sellFraction = Math.min(Math.max(fraction, 0), 1) * remainingFraction(position);
  const config = { ...loadTradeConfig(), mode: position.mode };
  try {
    const fill = await executeSell(chain, config, position, sellFraction, price);
    recordExit(position, {
      at: new Date().toISOString(),
      priceUsd: fill.priceUsd,
      fraction: sellFraction,
      proceedsUsd: fill.proceedsUsd ?? 0,
      reason: "manual exit",
      txHash: fill.txHash,
    });
    position.highWaterUsd = Math.max(position.highWaterUsd, price);
    await savePositions(file);
    await writePositionsJson(file, { [position.token.toLowerCase()]: price });
    const pnl = totalPnlUsd(position, price);
    await appendTradeJournal(
      `📤 手动平仓 ${position.symbol} [${chain}/${position.mode}] 卖出 ${(sellFraction * 100).toFixed(0)}% @ $${fill.priceUsd.toPrecision(4)} → $${(fill.proceedsUsd ?? 0).toFixed(2)} | 持仓盈亏 ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
    );
    return (
      `Sold ${(sellFraction * 100).toFixed(0)}% of ${position.symbol} [${chain}/${position.mode}] ` +
      `@ $${fill.priceUsd.toPrecision(4)} → $${(fill.proceedsUsd ?? 0).toFixed(2)}. ` +
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
  opts?: { smartMoney?: boolean; momentum?: boolean },
): Promise<string> {
  const chain = positionChain(chainId);
  const config = loadTradeConfig();
  if (config.mode === "off") return "交易未开启 (TRADE_MODE=off)";
  if (tradingPaused()) return "交易已暂停 (/resume 恢复)";

  // Momentum entries are capped at a smaller size — higher noise, more misses.
  const maxUsd = opts?.momentum ? config.momentumMaxUsdPerTrade : config.usdPerTrade;
  const clamped = Math.min(usd, maxUsd);
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
  file.positions.push(position);
  await savePositions(file);
  await writePositionsJson(file);
  await appendTradeJournal(
    `📥 AI开仓 ${position.symbol} [${chain}/${config.mode}] $${clamped} @ $${fill.priceUsd.toPrecision(4)} (${fill.amountTokens.toFixed(2)} 枚) — 理由: ${reason}${fill.txHash ? ` tx:${fill.txHash}` : ""}`,
  );
  await notify(
    `🤖 ${modeTag(config)} 🟢 买入 **${position.symbol}** [${chain}]${fdvTag(analysis.fdvUsd)}\n` +
      `$${clamped.toFixed(2)} @ $${fill.priceUsd.toPrecision(6)} (${fill.amountTokens.toFixed(2)} 枚)\n` +
      `理由: ${reason}${fill.txHash ? `\nTx: ${fill.txHash}` : ""}`,
    {},
    chain,
    position.token,
  );
  return `✅ 已开仓 ${position.symbol} [${chain}/${config.mode}] $${clamped} @ $${fill.priceUsd.toPrecision(4)} (${fill.amountTokens.toFixed(2)} 枚)`;
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
    };
  });
  const payload = JSON.stringify(
    { meta: { updated_at: new Date().toISOString(), count: rows.length }, positions: rows },
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
          `🛑 ${modeTag(config)} entry VETOED [${chain}] ${candidate.symbol}: ${safety.flags.join(", ")}`,
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
        `📥 开仓 ${position.symbol} [${chain}/${config.mode}] $${config.usdPerTrade} @ $${fill.priceUsd.toPrecision(4)} (${fill.amountTokens.toFixed(2)} 枚) — 触发: ${position.trigger}${fill.txHash ? ` tx:${fill.txHash}` : ""}`,
      );
      await notify(
        [
          `${modeTag(config)} 🟢 买入 **${position.symbol ?? position.token}** [${chain}]${fdvTag(ev.input.fdvUsd)}`,
          `$${config.usdPerTrade.toFixed(2)} @ $${fill.priceUsd.toPrecision(6)} (${fill.amountTokens.toFixed(2)} 枚)`,
          `触发: ${position.trigger}`,
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
        `⚠️ ${modeTag(config)} entry FAILED for ${candidate.symbol}: ${(err as Error).message}`,
        options,
        chain,
      );
    }
  }

  await savePositions(file);
  if (opened.length) await writePositionsJson(file);
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
          `📤 平仓 ${position.symbol} [${chain}/${config.mode}] 卖出 ${(action.fraction * 100).toFixed(0)}% @ $${fill.priceUsd.toPrecision(4)} → $${(fill.proceedsUsd ?? 0).toFixed(2)} — 原因: ${action.reason} | 持仓盈亏 ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${position.status})`,
        );
        await notify(
          [
            `${modeTag(config)} 📤 **${position.symbol ?? position.token}** [${chain}] — ${action.reason}`,
            `平 ${(action.fraction * 100).toFixed(0)}% @ $${fill.priceUsd.toPrecision(6)} → $${(fill.proceedsUsd ?? 0).toFixed(2)}${fdvTag(fdvUsd)}`,
            `仓位盈亏 ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${position.status})`,
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

  const dayMs = 24 * 60 * 60 * 1000;
  const dueDailyReport =
    file.positions.length > 0 &&
    (!file.lastReportAt || Date.now() - new Date(file.lastReportAt).getTime() > dayMs);
  if (dueDailyReport) file.lastReportAt = new Date().toISOString();

  await savePositions(file);
  await writePositionsJson(file, marks);

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
          `盈亏 ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
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
