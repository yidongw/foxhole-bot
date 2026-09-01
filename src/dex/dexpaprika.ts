export interface OhlcvCandle {
  time_open: string;
  time_close: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const BASE = "https://api.dexpaprika.com/networks/robinhood";

export async function fetchPoolOhlcv(
  poolId: string,
  options: {
    start: string;
    interval?: "1h" | "6h" | "24h";
    limit?: number;
  },
): Promise<OhlcvCandle[]> {
  const params = new URLSearchParams({
    start: options.start,
    interval: options.interval ?? "24h",
    limit: String(options.limit ?? 120),
  });
  const res = await fetch(`${BASE}/pools/${poolId}/ohlcv?${params}`, {
    headers: { "User-Agent": "foxhole-bot/0.3" },
  });
  if (!res.ok) {
    throw new Error(`DexPaprika OHLCV ${res.status} for pool ${poolId}`);
  }
  const data = (await res.json()) as OhlcvCandle[];
  return [...data].sort(
    (a, b) => new Date(a.time_open).getTime() - new Date(b.time_open).getTime(),
  );
}

export async function fetchPoolMeta(poolId: string) {
  const res = await fetch(`${BASE}/pools/${poolId}`, {
    headers: { "User-Agent": "foxhole-bot/0.3" },
  });
  if (!res.ok) throw new Error(`DexPaprika pool ${res.status}`);
  return res.json() as Promise<{
    id: string;
    created_at: string;
    created_at_block_number: number;
    base_token_id: string;
    quote_token_id: string;
    tokens: Array<{ id: string; symbol: string; name: string }>;
    token_reserves?: Array<{ token_id: string; reserve: string; reserve_usd: number }>;
    liquidity_usd: number;
  }>;
}

/** Extract pool id from DexScreener URL path. */
export function poolIdFromDexUrl(url: string): string | undefined {
  const m = url.match(/dexscreener\.com\/robinhood\/(0x[a-fA-F0-9]+)/);
  return m?.[1];
}
