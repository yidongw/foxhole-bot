import type { Address } from "viem";

import { fetchTokenPriceUsd } from "../dex/dexscreener.js";
import { sendDiscordMessage } from "../notify/discord.js";
import { sleep } from "../lib/utils.js";
import type { SignalEvaluation } from "../signals/types.js";
import { loadTradeConfig, type TradeConfig } from "./config.js";
import {
  loadPositions,
  openPositions,
  recordExit,
  remainingFraction,
  savePositions,
  totalPnlUsd,
  realizedUsd,
  type Position,
  type PositionsFile,
} from "./positions.js";
import { checkEntry } from "./risk.js";
import { evaluateExits } from "./exits.js";
import { buy, sell } from "./execute.js";

export interface EngineOptions {
  dryRun?: boolean;
  webhookUrl?: string;
}

async function notify(body: string, options: EngineOptions): Promise<void> {
  if (options.dryRun) {
    console.log("--- DRY RUN TRADE ---\n" + body + "\n");
    return;
  }
  const url = options.webhookUrl ?? process.env.DISCORD_WEBHOOK_URL;
  if (url) await sendDiscordMessage(url, body).catch((err) => console.error(err));
  else console.log(body);
}

function modeTag(config: TradeConfig): string {
  return config.mode === "paper" ? "📝 PAPER" : "💸 LIVE";
}

/** Attempt entries for qualifying signal evaluations. */
export async function processSignals(
  evaluations: SignalEvaluation[],
  options: EngineOptions = {},
  config: TradeConfig = loadTradeConfig(),
): Promise<Position[]> {
  if (config.mode === "off") return [];
  const file = await loadPositions();
  const opened: Position[] = [];

  for (const ev of evaluations) {
    const candidate = {
      token: ev.input.address,
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

    try {
      const fill = await buy(
        config,
        candidate.token as Address,
        candidate.priceUsd!,
        config.usdPerTrade,
      );
      const position: Position = {
        id: `${candidate.token.toLowerCase()}-${Date.now()}`,
        mode: config.mode,
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
      await notify(
        [
          `${modeTag(config)} **ENTRY** ${position.symbol ?? position.token}`,
          `$${config.usdPerTrade} @ $${fill.priceUsd.toPrecision(4)} (${fill.amountTokens.toFixed(2)} tokens)`,
          `Trigger: ${position.trigger}`,
          fill.txHash ? `Tx: ${fill.txHash}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        options,
      );
    } catch (err) {
      console.error(`entry failed ${candidate.symbol}:`, (err as Error).message);
      await notify(
        `⚠️ ${modeTag(config)} entry FAILED for ${candidate.symbol}: ${(err as Error).message}`,
        options,
      );
    }
  }

  await savePositions(file);
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

  for (const position of open) {
    let price: number | undefined;
    try {
      price = await fetchTokenPriceUsd(position.token);
    } catch (err) {
      console.error(`price fetch failed ${position.symbol}:`, (err as Error).message);
    }
    if (price == null || price <= 0) continue;

    position.highWaterUsd = Math.max(position.highWaterUsd, price);
    const actions = evaluateExits(position, price, config);

    for (const action of actions) {
      try {
        const fill = await sell(config, position, action.fraction, price);
        recordExit(position, {
          at: new Date().toISOString(),
          priceUsd: fill.priceUsd,
          fraction: action.fraction,
          proceedsUsd: fill.proceedsUsd ?? 0,
          reason: action.reason,
          txHash: fill.txHash,
        });
        const pnl = totalPnlUsd(position, price);
        await notify(
          [
            `${modeTag(config)} **EXIT** ${position.symbol ?? position.token} — ${action.reason}`,
            `Sold ${(action.fraction * 100).toFixed(0)}% @ $${fill.priceUsd.toPrecision(4)} → $${(fill.proceedsUsd ?? 0).toFixed(2)}`,
            `Position P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${position.status})`,
            fill.txHash ? `Tx: ${fill.txHash}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          options,
        );
      } catch (err) {
        console.error(`exit failed ${position.symbol}:`, (err as Error).message);
      }
    }
    await sleep(250);
  }

  const dayMs = 24 * 60 * 60 * 1000;
  if (
    file.positions.length &&
    (!file.lastReportAt || Date.now() - new Date(file.lastReportAt).getTime() > dayMs)
  ) {
    file.lastReportAt = new Date().toISOString();
    await savePositions(file);
    await notify(`📊 **Daily P&L**\n${await formatPortfolioReport()}`, options);
    return;
  }

  await savePositions(file);
}

export async function formatPortfolioReport(): Promise<string> {
  const file = await loadPositions();
  if (!file.positions.length) return "No positions yet.";

  const lines: string[] = [];
  const open = openPositions(file);
  if (open.length) {
    lines.push(`**Open positions (${open.length})**`);
    for (const p of open) {
      let price: number | undefined;
      try {
        price = await fetchTokenPriceUsd(p.token);
      } catch {}
      const pnl = totalPnlUsd(p, price);
      const rem = remainingFraction(p);
      lines.push(
        `• ${p.symbol ?? p.token} [${p.mode}] ${(rem * 100).toFixed(0)}% left, ` +
          `entry $${p.entryPriceUsd.toPrecision(4)}${price ? `, now $${price.toPrecision(4)}` : ""}, ` +
          `P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
      );
      await sleep(200);
    }
  }

  const closed = file.positions.filter((p) => p.status === "closed");
  if (closed.length) {
    const realized = closed.reduce((s, p) => s + realizedUsd(p) - p.costUsd, 0);
    lines.push(
      `**Closed: ${closed.length}, realized P&L ${realized >= 0 ? "+" : ""}$${realized.toFixed(2)}**`,
    );
  }
  return lines.join("\n");
}
