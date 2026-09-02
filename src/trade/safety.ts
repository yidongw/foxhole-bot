import { GoPlus } from "@goplus/sdk-node";

import { fetchPoolOhlcv } from "../dex/dexpaprika.js";
import { detectLadderPump } from "../signals/ladder.js";

/**
 * GoPlus pre-entry safety gate (EVM + Solana). Hard veto on rug mechanics;
 * fails OPEN on API errors (logged) so a GoPlus outage can't freeze exits or
 * paper research — the risk caps still bound the damage.
 */

const GOPLUS_CHAIN_IDS: Record<string, string> = {
  ethereum: "1",
  bsc: "56",
  base: "8453",
};

export interface SafetyVerdict {
  ok: boolean;
  flags: string[];
  source: "goplus" | "goplus-solana" | "unavailable" | "unsupported";
}

interface GoPlusTokenData {
  is_honeypot?: string;
  cannot_sell_all?: string;
  buy_tax?: string;
  sell_tax?: string;
  is_mintable?: string;
  can_take_back_ownership?: string;
  owner_change_balance?: string;
  hidden_owner?: string;
  selfdestruct?: string;
  transfer_pausable?: string;
  is_open_source?: string;
}

/** Pure veto rules — exported for tests. */
export function evaluateGoPlusFlags(data: GoPlusTokenData): string[] {
  const flags: string[] = [];
  const truthy = (v?: string) => v === "1";
  if (truthy(data.is_honeypot)) flags.push("honeypot");
  if (truthy(data.cannot_sell_all)) flags.push("cannot_sell_all");
  const buyTax = Number(data.buy_tax ?? 0);
  const sellTax = Number(data.sell_tax ?? 0);
  if (buyTax > 0.1) flags.push(`buy_tax ${(buyTax * 100).toFixed(0)}%`);
  if (sellTax > 0.1) flags.push(`sell_tax ${(sellTax * 100).toFixed(0)}%`);
  if (truthy(data.is_mintable)) flags.push("mintable");
  if (truthy(data.can_take_back_ownership)) flags.push("ownership_recallable");
  if (truthy(data.owner_change_balance)) flags.push("owner_can_edit_balances");
  if (truthy(data.hidden_owner)) flags.push("hidden_owner");
  if (truthy(data.selfdestruct)) flags.push("selfdestruct");
  if (truthy(data.transfer_pausable)) flags.push("transfer_pausable");
  if (data.is_open_source === "0") flags.push("closed_source");
  return flags;
}

const cache = new Map<string, { verdict: SafetyVerdict; at: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

export function safetyGateEnabled(): boolean {
  return process.env.TRADE_SAFETY_GATE !== "0";
}

/** 24h+ of near-perfect staircase = wash bots painting the chart. */
async function checkLadder(chain: string, poolId: string): Promise<string | undefined> {
  try {
    const start = new Date(Date.now() - 36 * 3_600_000).toISOString().slice(0, 10);
    const candles = await fetchPoolOhlcv(poolId, {
      start,
      interval: "1h",
      limit: 48,
      network: chain,
    });
    const verdict = detectLadderPump(candles);
    if (verdict.isLadder && verdict.metrics) {
      return `ladder_pump (${verdict.metrics.candles}h straight, ${(verdict.metrics.greenRatio * 100).toFixed(0)}% green)`;
    }
  } catch {
    // no candles — other gates still apply
  }
  return undefined;
}

export async function checkTokenSafety(
  chain: string,
  token: string,
  poolId?: string,
): Promise<SafetyVerdict> {
  const key = `${chain}:${token.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.verdict;

  let verdict: SafetyVerdict;
  try {
    if (chain === "solana") {
      const res = (await GoPlus.solanaTokenSecurity([token], 30)) as {
        code: number;
        result?: Record<string, unknown>;
      };
      if (res.code !== 1 || !res.result?.[token]) {
        verdict = { ok: true, flags: [], source: "unavailable" };
      } else {
        const d = res.result[token] as {
          mintable?: { status?: string };
          freezable?: { status?: string };
          transfer_fee_upgradable?: { status?: string };
          closable?: { status?: string };
          holders?: Array<{ percent?: string; is_locked?: number }>;
        };
        const flags: string[] = [];
        if (d.mintable?.status === "1") flags.push("mintable");
        if (d.freezable?.status === "1") flags.push("freezable");
        if (d.closable?.status === "1") flags.push("closable");
        if (d.transfer_fee_upgradable?.status === "1") flags.push("fee_upgradable");
        // A single unlocked wallet with a supermajority of supply is a dump
        // bomb even when every authority is revoked (seen live: "TSLA" mint
        // 5PiMV…, one wallet held 80% while the pool held 1.6%). Threshold
        // sits above typical AMM-pool holdings to avoid vetoing normal
        // graduated tokens.
        const top = d.holders?.[0];
        const topPct = Number(top?.percent ?? 0);
        if (top && topPct >= 0.6 && top.is_locked !== 1) {
          flags.push(`top_holder ${(topPct * 100).toFixed(0)}% unlocked`);
        }
        verdict = { ok: flags.length === 0, flags, source: "goplus-solana" };
      }
    } else if (GOPLUS_CHAIN_IDS[chain]) {
      const res = (await GoPlus.tokenSecurity(
        GOPLUS_CHAIN_IDS[chain],
        [token],
        30,
      )) as { code: number; result?: Record<string, GoPlusTokenData> };
      const data = res.result?.[token.toLowerCase()];
      if (res.code !== 1 || !data) {
        verdict = { ok: true, flags: [], source: "unavailable" };
      } else {
        const flags = evaluateGoPlusFlags(data);
        verdict = { ok: flags.length === 0, flags, source: "goplus" };
      }
    } else {
      // robinhood etc. — GoPlus has no coverage; other gates still apply
      verdict = { ok: true, flags: [], source: "unsupported" };
    }
  } catch (err) {
    console.error(`safety check failed ${chain}:${token}:`, (err as Error).message);
    verdict = { ok: true, flags: [], source: "unavailable" };
  }

  if (poolId) {
    const ladderFlag = await checkLadder(chain, poolId);
    if (ladderFlag) {
      verdict = { ...verdict, ok: false, flags: [...verdict.flags, ladderFlag] };
    }
  }

  cache.set(key, { verdict, at: Date.now() });
  return verdict;
}
