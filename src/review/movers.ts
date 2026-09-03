import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchDexJson } from "../dex/dexscreener.js";
import { fetchPoolOhlcv } from "../dex/dexpaprika.js";
import { fetchGtOhlcv, fetchGtTrendingPools } from "../dex/geckoterminal.js";
import { detectLadderPump } from "../signals/ladder.js";
import { loadDenylist } from "./denylist.js";
import { checkTokenSafety } from "../trade/safety.js";
import { sleep } from "../lib/utils.js";
import type { MonitorState } from "../monitor/state.js";
import type { DexPair } from "../types.js";
import type { AlertRecord, LabeledOutcome } from "./ledger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MISSED_PATH = path.resolve(__dirname, "../../data/outcomes/missed.json");

/** A pump has to at least double to count as 暴涨. */
export const MOVER_MIN_CHANGE_PCT = 100;
/** Above this the pool is almost certainly broken data. */
export const MOVER_MAX_CHANGE_PCT = 10_000;
export const MOVER_MIN_LIQUIDITY_USD = 30_000;
export const MOVER_MIN_VOLUME_USD = 100_000;
/** A miss only counts if the token's CURRENT market cap (FDV) is at least this.
 *  用户规则: 错过的币至少市值到过 $10M。可靠的历史峰值算不出(免费 OHLCV 对新币/
 *  robinhood 逐池脏、刻度乱),所以改用 DexScreener 当前 fdv + 高频(每2h)扫描——
 *  趁币还在高位就抓到,当前 fdv 即近似峰值。可用 MOVER_MIN_FDV_USD 覆盖。 */
export const MOVER_MIN_FDV_USD = Number(process.env.MOVER_MIN_FDV_USD ?? 10_000_000);

const EXCLUDED_SYMBOLS = new Set([
  "WETH", "ETH", "WBNB", "BNB", "SOL", "WSOL", "USDT", "USDC", "USDG",
  "DAI", "WBTC", "BTCB", "CAKE", "UNI",
]);

interface PaprikaPool {
  id: string;
  volume_usd_24h?: number;
  price_change_percentage_24h?: number;
  liquidity_usd?: number;
}

export interface Mover {
  chain: string;
  poolId: string;
  address: string;
  symbol?: string;
  priceChange24h: number;
  volume24hUsd: number;
  liquidityUsd: number;
  /** Current fully-diluted valuation (≈ market cap for full-circulating memes).
   *  From DexScreener — the reliable current-mcap signal we gate misses on. */
  fdvUsd?: number;
}

export type MissKind = "alerted" | "threshold_miss" | "coverage_miss";

export interface ClassifiedMover extends Mover {
  kind: MissKind;
  /** Wash-bot staircase chart — excluded from tuner cases and entries. */
  ladder?: boolean;
  /** Last price fell >60% from window high — pump already unwound/rugged. */
  collapsed?: boolean;
  /** No OHLCV from any source — usually a drained/delisted pool. */
  noData?: boolean;
  /** GoPlus/holder-concentration flags from the safety gate. */
  safetyFlags?: string[];
  /** BlockBeats（区块律动）对照：该币已被新闻报道过 = 新闻通道也漏了。 */
  newsNote?: string;
}

/** Chart health from both candle sources at two granularities. */
export async function assessMoverChart(
  chain: string,
  poolId: string,
): Promise<{ ladder: boolean; collapsed: boolean; noData: boolean }> {
  let hourly: Awaited<ReturnType<typeof fetchPoolOhlcv>> = [];
  let fine: typeof hourly = [];
  try {
    const start = new Date(Date.now() - 48 * 3_600_000).toISOString().slice(0, 10);
    hourly = await fetchPoolOhlcv(poolId, { start, interval: "1h", limit: 60, network: chain });
  } catch {}
  await sleep(400);
  try {
    fine = await fetchGtOhlcv(chain, poolId, { timeframe: "minute", aggregate: 15, limit: 100 });
  } catch {}

  const all = hourly.length ? hourly : fine;
  if (!all.length) return { ladder: false, collapsed: false, noData: true };

  const ladder =
    detectLadderPump(hourly).isLadder || detectLadderPump(fine).isLadder;
  const maxHigh = Math.max(...all.map((c) => c.high));
  const last = all[all.length - 1].close;
  const collapsed = maxHigh > 0 && last < maxHigh * 0.4;
  return { ladder, collapsed, noData: false };
}

export interface MissedCase extends ClassifiedMover {
  detectedAt: string;
}

function passesMoverFilters(chg: number, liq: number, vol: number): boolean {
  return (
    chg >= MOVER_MIN_CHANGE_PCT &&
    chg <= MOVER_MAX_CHANGE_PCT &&
    liq >= MOVER_MIN_LIQUIDITY_USD &&
    vol >= MOVER_MIN_VOLUME_USD
  );
}

/**
 * Top 暴涨 tokens on a chain in the last 24h, from two sources:
 * 1. DexPaprika pages 1-3 by volume (volume-sorted because price-change
 *    sorting surfaces broken pools) — catches big-volume movers
 * 2. GeckoTerminal trending pools — catches organic movers that volume
 *    ranking buries under wash-traded garbage
 */
export async function fetchTopMovers(chain: string, limit = 12): Promise<Mover[]> {
  const seen = new Set<string>();
  for (const d of await loadDenylist()) {
    if (d.chain === chain) seen.add(d.address.toLowerCase());
  }
  const movers: Mover[] = [];

  // Source 1: DexPaprika top-100-by-volume (page/offset params are broken —
  // the API returns identical content; one request is all there is).
  // Coarse filter on VOLUME only; chg/liq judged from DexScreener pair data
  // because DexPaprika's chg is backward-looking (JINQIAN showed -37% mid
  // retrace after a +700% day) and its liquidity can be badly stale
  // ($10.7K reported vs $5.7M real).
  let paprika: PaprikaPool[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(
        `https://api.dexpaprika.com/networks/${chain}/pools/search?limit=100&order_by=volume_usd_24h&sort=desc`,
        { headers: { "User-Agent": "foxhole-bot/0.3" } },
      );
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      if (res.ok) {
        paprika = ((await res.json()) as { results?: PaprikaPool[] }).results ?? [];
      }
      break;
    } catch {
      await sleep(700 * (attempt + 1));
    }
  }
  const candidates = paprika.filter(
    (p) => (p.volume_usd_24h ?? 0) >= MOVER_MIN_VOLUME_USD,
  );
  for (const pool of candidates) {
    if (movers.length >= limit) break;
    try {
      const pair = await fetchDexJson<{ pairs?: DexPair[] }>(
        `/latest/dex/pairs/${chain}/${pool.id}`,
      );
      const p = pair.pairs?.[0];
      const symbol = p?.baseToken?.symbol;
      const address = p?.baseToken?.address;
      if (!address || seen.has(address.toLowerCase())) continue;
      if (symbol && EXCLUDED_SYMBOLS.has(symbol.toUpperCase())) continue;
      // fine filter on DexScreener's numbers (live, forward-looking h24)
      const chg = Number(p?.priceChange?.h24 ?? 0);
      const liq = Number(p?.liquidity?.usd ?? 0);
      const vol = Number(p?.volume?.h24 ?? pool.volume_usd_24h ?? 0);
      if (!passesMoverFilters(chg, liq, vol)) continue;
      seen.add(address.toLowerCase());
      movers.push({
        chain,
        poolId: pool.id,
        address,
        symbol,
        priceChange24h: chg,
        volume24hUsd: vol,
        liquidityUsd: liq,
        fdvUsd: Number(p?.fdv ?? 0) || undefined,
      });
    } catch {
      // pair not on DexScreener — skip
    }
    await sleep(200);
  }

  // Source 2: GeckoTerminal trending (organic hotness)
  try {
    for (const t of await fetchGtTrendingPools(chain)) {
      if (movers.length >= limit * 2) break;
      if (!passesMoverFilters(t.priceChange24h, t.liquidityUsd, t.volume24hUsd)) continue;
      if (seen.has(t.address.toLowerCase())) continue;
      if (t.symbol && EXCLUDED_SYMBOLS.has(t.symbol.toUpperCase())) continue;
      seen.add(t.address.toLowerCase());
      // GT trending has no FDV — look it up on DexScreener so the mcap gate
      // applies here too (undefined only if the lookup fails → kept for review).
      let fdvUsd: number | undefined;
      try {
        const pair = await fetchDexJson<{ pairs?: DexPair[] }>(
          `/latest/dex/pairs/${chain}/${t.poolId}`,
        );
        fdvUsd = Number(pair.pairs?.[0]?.fdv ?? 0) || undefined;
      } catch {}
      movers.push({
        chain,
        poolId: t.poolId,
        address: t.address,
        symbol: t.symbol,
        priceChange24h: t.priceChange24h,
        volume24hUsd: t.volume24hUsd,
        liquidityUsd: t.liquidityUsd,
        fdvUsd,
      });
    }
  } catch (err) {
    console.error(`${chain} GT trending failed:`, (err as Error).message);
  }

  return movers;
}

/** Mover token addresses as an extra discovery feed for the regular scan. */
export async function fetchMoverCandidates(chain: string): Promise<string[]> {
  try {
    return (await fetchTopMovers(chain, 10)).map((m) => m.address);
  } catch (err) {
    console.error(`${chain} movers feed failed:`, (err as Error).message);
    return [];
  }
}

/** Pure classification — exported for tests. */
export function classifyMover(
  mover: Mover,
  state: MonitorState,
  ledger: Array<Pick<AlertRecord, "chain" | "address" | "at">>,
  now: number = Date.now(),
): MissKind {
  const key = `${mover.chain}:${mover.address.toLowerCase()}`;
  const windowMs = 36 * 60 * 60 * 1000;
  const alerted = ledger.some(
    (r) =>
      `${r.chain}:${r.address.toLowerCase()}` === key &&
      now - new Date(r.at).getTime() < windowMs,
  );
  if (alerted) return "alerted";

  const stateKey =
    mover.chain === "robinhood"
      ? mover.address.toLowerCase()
      : `${mover.chain}:${mover.address.toLowerCase()}`;
  return state.tokens[stateKey] ? "threshold_miss" : "coverage_miss";
}

export async function loadMissedCases(): Promise<MissedCase[]> {
  try {
    return JSON.parse(await readFile(MISSED_PATH, "utf8")) as MissedCase[];
  } catch {
    return [];
  }
}

export async function saveMissedCases(
  fresh: ClassifiedMover[],
): Promise<MissedCase[]> {
  const existing = await loadMissedCases();
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set(
    existing.map((m) => `${m.chain}:${m.address.toLowerCase()}:${m.detectedAt.slice(0, 10)}`),
  );
  const added: MissedCase[] = [];
  for (const m of fresh) {
    if (m.kind === "alerted") continue;
    // Ladder pumps are not real misses — training the tuner to capture
    // wash-painted charts would optimize toward exit-liquidity traps.
    // No-data pools can't be replayed at all. (Collapsed pumps stay: we
    // should have alerted before the collapse — that's a real miss.)
    if (m.ladder || m.noData) continue;
    if (m.fdvUsd != null && m.fdvUsd < MOVER_MIN_FDV_USD) continue;
    const key = `${m.chain}:${m.address.toLowerCase()}:${today}`;
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({ ...m, detectedAt: new Date().toISOString() });
  }
  if (added.length) {
    await mkdir(path.dirname(MISSED_PATH), { recursive: true });
    await writeFile(
      MISSED_PATH,
      JSON.stringify([...existing, ...added], null, 2),
      "utf8",
    );
  }
  return added;
}

/** Full daily mover sweep across chains: classify + persist misses. */
export async function scanMissedMovers(
  chains: string[],
  state: MonitorState,
  ledger: Array<Pick<AlertRecord, "chain" | "address" | "at">>,
): Promise<ClassifiedMover[]> {
  const classified: ClassifiedMover[] = [];
  for (const chain of chains) {
    try {
      const movers = await fetchTopMovers(chain);
      for (const m of movers) {
        const entry: ClassifiedMover = { ...m, kind: classifyMover(m, state, ledger) };
        if (entry.kind !== "alerted") {
          const health = await assessMoverChart(chain, m.poolId);
          entry.ladder = health.ladder;
          entry.collapsed = health.collapsed;
          entry.noData = health.noData;
          try {
            entry.safetyFlags = (await checkTokenSafety(chain, m.address)).flags;
          } catch {}
          await sleep(600);
        }
        classified.push(entry);
      }
    } catch (err) {
      console.error(`${chain} mover scan failed:`, (err as Error).message);
    }
    await sleep(300);
  }
  // NOTE: persistence to missed-cases happens in the review confirm phase —
  // candidates require human sign-off before they become tuner training data.
  return classified;
}

export type { LabeledOutcome };
