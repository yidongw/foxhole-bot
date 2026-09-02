import type { TradeConfig } from "./config.js";
import {
  findOpen,
  openPositions,
  spendSince,
  type PositionsFile,
} from "./positions.js";

export interface EntryCandidate {
  token: string;
  symbol?: string;
  priceUsd?: number;
  liquidityUsd: number;
  triggers: string[];
}

export interface RiskVerdict {
  ok: boolean;
  reason?: string;
}

/** Every entry must pass every gate — no exceptions, live or paper. */
export function checkEntry(
  config: TradeConfig,
  file: PositionsFile,
  candidate: EntryCandidate,
  now: Date = new Date(),
): RiskVerdict {
  if (config.mode === "off") return { ok: false, reason: "trading disabled" };

  if (!candidate.triggers.some((t) => config.entryTriggers.includes(t))) {
    return { ok: false, reason: "no qualifying entry trigger" };
  }
  if (config.denylist.includes(candidate.token.toLowerCase())) {
    return { ok: false, reason: "token on denylist" };
  }
  if (candidate.priceUsd == null || candidate.priceUsd <= 0) {
    return { ok: false, reason: "no usable price" };
  }
  if (candidate.liquidityUsd < config.minEntryLiquidityUsd) {
    return {
      ok: false,
      reason: `liquidity $${Math.round(candidate.liquidityUsd)} < min $${config.minEntryLiquidityUsd}`,
    };
  }
  if (findOpen(file, candidate.token)) {
    return { ok: false, reason: "position already open" };
  }
  if (openPositions(file).length >= config.maxOpenPositions) {
    return { ok: false, reason: `max open positions (${config.maxOpenPositions})` };
  }

  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const spent = spendSince(file, dayAgo);
  if (spent + config.usdPerTrade > config.maxDailySpendUsd) {
    return {
      ok: false,
      reason: `daily spend cap: $${Math.round(spent)} + $${config.usdPerTrade} > $${config.maxDailySpendUsd}`,
    };
  }

  return { ok: true };
}
