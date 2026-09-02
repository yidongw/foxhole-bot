import type { OhlcvCandle } from "./dexpaprika.js";

/**
 * GeckoTerminal free API (no key, ~30 req/min) — second market-data source:
 * finer OHLCV granularity than DexPaprika (minute aggregates) and a curated
 * trending-pools feed that surfaces organic movers the volume-sorted lists
 * bury under wash-traded garbage.
 */

const BASE = "https://api.geckoterminal.com/api/v2";

/** Our chain ids → GeckoTerminal network slugs (robinhood not listed there). */
const GT_NETWORKS: Record<string, string> = {
  solana: "solana",
  bsc: "bsc",
  base: "base",
  ethereum: "eth",
};

export function gtNetwork(chain: string): string | undefined {
  return GT_NETWORKS[chain];
}

async function gtJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "User-Agent": "foxhole-bot/0.3", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status}: ${path}`);
  return res.json() as Promise<T>;
}

interface GtOhlcvResponse {
  data?: { attributes?: { ohlcv_list?: [number, number, number, number, number, number][] } };
}

/** OHLCV at minute granularity, e.g. aggregate=15 → 15m candles. */
export async function fetchGtOhlcv(
  chain: string,
  poolId: string,
  options: { timeframe: "minute" | "hour"; aggregate: number; limit?: number },
): Promise<OhlcvCandle[]> {
  const network = gtNetwork(chain);
  if (!network) return [];
  const data = await gtJson<GtOhlcvResponse>(
    `/networks/${network}/pools/${poolId}/ohlcv/${options.timeframe}?aggregate=${options.aggregate}&limit=${options.limit ?? 100}`,
  );
  const list = data.data?.attributes?.ohlcv_list ?? [];
  const stepMs =
    options.aggregate * (options.timeframe === "minute" ? 60_000 : 3_600_000);
  return list
    .map(([ts, open, high, low, close, volume]) => ({
      time_open: new Date(ts * 1000).toISOString(),
      time_close: new Date(ts * 1000 + stepMs).toISOString(),
      open,
      high,
      low,
      close,
      volume,
    }))
    .sort((a, b) => a.time_open.localeCompare(b.time_open));
}

interface GtPool {
  attributes?: {
    address?: string;
    name?: string;
    reserve_in_usd?: string;
    volume_usd?: { h24?: string };
    price_change_percentage?: { h24?: string };
  };
  relationships?: { base_token?: { data?: { id?: string } } };
}

export interface GtTrendingPool {
  poolId: string;
  address: string;
  symbol?: string;
  priceChange24h: number;
  volume24hUsd: number;
  liquidityUsd: number;
}

/** Curated trending pools (organic hotness, not just raw volume). */
export async function fetchGtTrendingPools(chain: string): Promise<GtTrendingPool[]> {
  const network = gtNetwork(chain);
  if (!network) return [];
  const data = await gtJson<{ data?: GtPool[] }>(
    `/networks/${network}/trending_pools?page=1`,
  );
  const out: GtTrendingPool[] = [];
  for (const p of data.data ?? []) {
    const a = p.attributes;
    const tokenId = p.relationships?.base_token?.data?.id ?? "";
    const address = tokenId.replace(`${network}_`, "");
    if (!a?.address || !address) continue;
    out.push({
      poolId: a.address,
      address,
      symbol: a.name?.split("/")[0]?.trim(),
      priceChange24h: Number(a.price_change_percentage?.h24 ?? 0),
      volume24hUsd: Number(a.volume_usd?.h24 ?? 0),
      liquidityUsd: Number(a.reserve_in_usd ?? 0),
    });
  }
  return out;
}
