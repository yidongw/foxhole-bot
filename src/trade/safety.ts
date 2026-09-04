import { GoPlus } from "@goplus/sdk-node";

import { fetchPoolOhlcv } from "../dex/dexpaprika.js";
import { isDenylisted } from "../review/denylist.js";
import { fetchGtOhlcv } from "../dex/geckoterminal.js";
import { detectLadderPump } from "../signals/ladder.js";
import { fetchDexJson } from "../dex/dexscreener.js";
import {
  classifyStockQuote,
  fetchStockRegistry,
} from "../chains/robinhood/stock-registry.js";
import type { DexPair } from "../types.js";

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
  holders?: Array<{ percent?: string; is_locked?: number }>;
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
  // Concentration: a single UNLOCKED wallet holding a supermajority can dump the
  // whole pool. The EVM/GoPlus path historically skipped this — 肥嘟嘟(bsc)
  // passed the gate with 92% unlocked in the top holder (+ 1.4M airdrop-spam
  // holders faking legitimacy). Match the Solana path's ≥60% unlocked threshold.
  const top = data.holders?.[0];
  const topPct = Number(top?.percent ?? 0);
  if (top && topPct >= 0.6 && top.is_locked !== 1) {
    flags.push(`top_holder ${(topPct * 100).toFixed(0)}% unlocked`);
  }
  return flags;
}

const cache = new Map<string, { verdict: SafetyVerdict; at: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

export function safetyGateEnabled(): boolean {
  return process.env.TRADE_SAFETY_GATE !== "0";
}

/** Pools younger than this may legitimately have no OHLCV yet. */
export const FRESH_POOL_MAX_AGE_MS = 12 * 3_600_000;

/**
 * A pool this young with visible liquidity and trades cannot be "drained" —
 * the drained-pool heuristic (both candle sources empty) only holds for pools
 * old enough that indexers must have seen them. Ladder/collapse checks have
 * no data to run either way, and the other gates (GoPlus, denylist, stock
 * registry, liquidity floors) still apply.
 */
export function isLiveFreshPool(
  pair: DexPair | undefined,
  now = Date.now(),
): boolean {
  if (!pair?.pairCreatedAt) return false;
  if (now - pair.pairCreatedAt > FRESH_POOL_MAX_AGE_MS) return false;
  if ((pair.liquidity?.usd ?? 0) < 10_000) return false;
  const t = pair.txns?.h24;
  return (t?.buys ?? 0) + (t?.sells ?? 0) > 0;
}

/**
 * Chart checks at two granularities: slow ladders show on 1h candles
 * (AVANT: 22h staircase), fast ladders only on 15m (Pumpcat: 3h staircase
 * then rug). Both candle sources empty on a trading token usually means a
 * drained pool — veto rather than assume clean.
 */
async function checkChart(
  chain: string,
  poolId: string,
  onBondingCurve = false,
): Promise<string | undefined> {
  let hourly: Awaited<ReturnType<typeof fetchPoolOhlcv>> = [];
  let fine: typeof hourly = [];
  try {
    const start = new Date(Date.now() - 36 * 3_600_000).toISOString().slice(0, 10);
    hourly = await fetchPoolOhlcv(poolId, { start, interval: "1h", limit: 48, network: chain });
  } catch {}
  try {
    fine = await fetchGtOhlcv(chain, poolId, { timeframe: "minute", aggregate: 15, limit: 100 });
  } catch {}

  // Bonding-curve tokens pre-graduation have no AMM pool yet, so absent OHLCV
  // is expected, not a drained pool — GoPlus + curve state carry safety there.
  if (!hourly.length && !fine.length) {
    if (onBondingCurve) return undefined;
    // Candle indexers take hours to pick up brand-new pools, so an empty
    // chart on a young pool is lag, not a drained pool (GME 2026-09-04:
    // 1.8h-old pool, $107k liq, $2.6M h1 volume — vetoed while actively
    // trading). Confirm liveness from DexScreener before vetoing; if it is
    // unreachable or the pool is old/inactive, keep the conservative veto.
    try {
      const res = await fetchDexJson<{ pair?: DexPair; pairs?: DexPair[] }>(
        `/latest/dex/pairs/${chain}/${poolId}`,
      );
      if (isLiveFreshPool(res.pair ?? res.pairs?.[0])) return undefined;
    } catch {}
    return "no_chart_history";
  }

  for (const [candles, label] of [
    [hourly, "1h"],
    [fine, "15m"],
  ] as const) {
    const verdict = detectLadderPump(candles);
    if (verdict.isLadder && verdict.metrics) {
      return `ladder_pump (${verdict.metrics.candles}×${label} straight, ${(verdict.metrics.greenRatio * 100).toFixed(0)}% green)`;
    }
  }

  // Collapsed pump (same 40%-of-high rule as the mover sweep): NUDES kept
  // re-triggering trade signals during its distribution phase and the AI
  // decider had to veto each one by hand — the pump being over is a fact
  // the gate can see itself.
  const collapsed = collapseRatio(hourly.length ? hourly : fine);
  if (collapsed != null && collapsed < 0.4) {
    return `collapsed_pump (now ${(collapsed * 100).toFixed(0)}% of window high)`;
  }
  return undefined;
}

/**
 * Fake-stock-backing veto (mmk_btc thread, $JINQIAN): a pool that pairs the
 * meme against a token whose SYMBOL is a US stock but whose ADDRESS is not in
 * Robinhood's official registry is backed by a lookalike ERC-20, not the real
 * tokenized stock. Off Robinhood Chain no stock quote can be real at all.
 * Fails OPEN (registry unreachable / quote not a stock symbol) like the rest
 * of the gate. Returns the flag string, or undefined if nothing to veto.
 */
async function checkStockQuote(
  chain: string,
  poolId: string,
): Promise<string | undefined> {
  let quote: { symbol?: string; address?: string } | undefined;
  try {
    const data = await fetchDexJson<{ pairs?: DexPair[] }>(
      `/latest/dex/pairs/${chain}/${poolId}`,
    );
    quote = data.pairs?.[0]?.quoteToken;
  } catch {
    return undefined;
  }
  if (!quote?.symbol) return undefined;
  const registry = await fetchStockRegistry();
  const verdict = classifyStockQuote(quote.symbol, quote.address, chain, registry);
  if (verdict === "fake") {
    return `fake_stock_quote (${quote.symbol} quote not in RH registry)`;
  }
  return undefined;
}

/** Last close as a fraction of the window high; undefined when unknowable. */
export function collapseRatio(
  candles: Array<{ high: number; close: number }>,
): number | undefined {
  if (!candles.length) return undefined;
  const maxHigh = Math.max(...candles.map((c) => c.high));
  const last = candles[candles.length - 1].close;
  if (maxHigh <= 0) return undefined;
  return last / maxHigh;
}

export async function checkTokenSafety(
  chain: string,
  token: string,
  poolId?: string,
  opts?: { onBondingCurve?: boolean },
): Promise<SafetyVerdict> {
  // Curve flag in the key so a pre-graduation verdict (chart check skipped)
  // doesn't mask the full chart check once the token graduates to an AMM pool.
  const key = `${chain}:${token.toLowerCase()}:${opts?.onBondingCurve ? "curve" : "amm"}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.verdict;

  if (await isDenylisted(chain, token)) {
    const verdict: SafetyVerdict = {
      ok: false,
      flags: ["user_denylisted"],
      source: "unsupported",
    };
    cache.set(key, { verdict, at: Date.now() });
    return verdict;
  }

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
    const chartFlag = await checkChart(chain, poolId, opts?.onBondingCurve);
    if (chartFlag) {
      verdict = { ...verdict, ok: false, flags: [...verdict.flags, chartFlag] };
    }
    const stockFlag = await checkStockQuote(chain, poolId);
    if (stockFlag) {
      verdict = { ...verdict, ok: false, flags: [...verdict.flags, stockFlag] };
    }
  }

  cache.set(key, { verdict, at: Date.now() });
  return verdict;
}
