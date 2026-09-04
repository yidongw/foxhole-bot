import { tradeEnabledChains } from "../chains/adapter.js";
import type { TradeConfig } from "./config.js";
import {
  findOpen,
  openPositions,
  spendSince,
  type PositionsFile,
} from "./positions.js";

export interface EntryCandidate {
  token: string;
  chain?: string;
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

  const chain = candidate.chain ?? "robinhood";
  if (!tradeEnabledChains().includes(chain as never)) {
    return { ok: false, reason: `trading not enabled on ${chain} (TRADE_CHAINS)` };
  }
  if (!candidate.triggers.some((t) => config.entryTriggers.includes(t))) {
    return { ok: false, reason: "no qualifying entry trigger" };
  }
  if (candidate.triggers.includes("post_pump")) {
    return { ok: false, reason: "post-pump signal — move already happened" };
  }
  if (candidate.triggers.includes("falling_knife")) {
    return { ok: false, reason: "falling knife — volume is distribution, price dropping" };
  }
  if (candidate.triggers.includes("micro_cap")) {
    return { ok: false, reason: "micro-cap — FDV below the nano-dust floor" };
  }
  if (config.denylist.includes(candidate.token.toLowerCase())) {
    return { ok: false, reason: "token on denylist" };
  }
  if (candidate.priceUsd == null || candidate.priceUsd <= 0) {
    return { ok: false, reason: "no usable price" };
  }
  const isSmartMoney = candidate.triggers.includes("smart_money");
  // Pure momentum: has momentum_strong but none of the conviction-grade triggers.
  const convictionTriggers = ["lock_strong", "lock_rising_strong", "boner_composite", "curve_near_grad_strong"];
  const isPureMomentum =
    candidate.triggers.includes("momentum_strong") &&
    !candidate.triggers.some((t) => convictionTriggers.includes(t)) &&
    !isSmartMoney;
  const minLiquidity = isSmartMoney
    ? config.minEntryLiquiditySmartMoneyUsd
    : isPureMomentum
      ? config.minEntryLiquidityMomentumUsd
      : config.minEntryLiquidityUsd;
  if (candidate.liquidityUsd < minLiquidity) {
    const tag = isSmartMoney ? " (smart_money)" : isPureMomentum ? " (momentum)" : "";
    return {
      ok: false,
      reason: `liquidity $${Math.round(candidate.liquidityUsd)} < min $${minLiquidity}${tag}`,
    };
  }
  if (findOpen(file, candidate.token)) {
    return { ok: false, reason: "position already open" };
  }
  if (openPositions(file).length >= config.maxOpenPositions) {
    return { ok: false, reason: `max open positions (${config.maxOpenPositions})` };
  }

  // maxDailySpendUsd <= 0 disables the cap entirely (user opt-out).
  if (config.maxDailySpendUsd > 0) {
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const spent = spendSince(file, dayAgo);
    if (spent + config.usdPerTrade > config.maxDailySpendUsd) {
      return {
        ok: false,
        reason: `24h capital-at-risk cap: $${Math.round(spent)} + $${config.usdPerTrade} > $${config.maxDailySpendUsd}`,
      };
    }
  }

  return { ok: true };
}
