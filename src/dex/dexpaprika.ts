export interface OhlcvCandle {
  time_open: string;
  time_close: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type OhlcvInterval = "1m" | "5m" | "15m" | "1h" | "6h" | "24h";

const BASE = "https://api.dexpaprika.com/networks/robinhood";
const PAGE_LIMIT = 366;

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url: string, retries = 6): Promise<unknown> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      headers: { "User-Agent": "foxhole-bot/0.3" },
    });
    if (res.status === 429 && attempt < retries) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      throw new Error(`DexPaprika ${res.status} ${url}`);
    }
    return res.json();
  }
  throw new Error(`DexPaprika rate limited: ${url}`);
}

export async function fetchPoolOhlcv(
  poolId: string,
  options: {
    start: string;
    interval?: OhlcvInterval;
    limit?: number;
  },
): Promise<OhlcvCandle[]> {
  const params = new URLSearchParams({
    start: options.start,
    interval: options.interval ?? "24h",
    limit: String(Math.min(options.limit ?? 120, PAGE_LIMIT)),
  });
  const data = (await fetchJson(
    `${BASE}/pools/${poolId}/ohlcv?${params}`,
  )) as OhlcvCandle[] | { message?: string };
  if (!Array.isArray(data)) {
    throw new Error(
      `DexPaprika OHLCV error: ${"message" in data ? data.message : "unknown"}`,
    );
  }
  return [...data].sort(
    (a, b) => new Date(a.time_open).getTime() - new Date(b.time_open).getTime(),
  );
}

/**
 * Paginate OHLCV until `end` or no more data (DexPaprika max 366 candles/request).
 */
export async function fetchPoolOhlcvRange(
  poolId: string,
  options: {
    start: string;
    end?: string;
    interval: OhlcvInterval;
    maxCandles?: number;
  },
): Promise<OhlcvCandle[]> {
  const endMs = options.end ? new Date(options.end).getTime() : Infinity;
  const maxCandles = options.maxCandles ?? 20_000;
  const byOpen = new Map<string, OhlcvCandle>();
  let cursor = options.start;

  while (byOpen.size < maxCandles) {
    const batch = await fetchPoolOhlcv(poolId, {
      start: cursor,
      interval: options.interval,
      limit: PAGE_LIMIT,
    });
    if (!batch.length) break;

    let newInBatch = 0;
    for (const c of batch) {
      const openMs = new Date(c.time_open).getTime();
      if (openMs > endMs) continue;
      if (!byOpen.has(c.time_open)) {
        byOpen.set(c.time_open, c);
        newInBatch++;
      }
    }

    const last = batch[batch.length - 1]!;
    const lastCloseMs = new Date(last.time_close).getTime();
    if (lastCloseMs >= endMs) break;

    const nextCursor = last.time_close;
    if (nextCursor === cursor && newInBatch === 0) break;
    cursor = nextCursor;
    await sleep(250);
  }

  return [...byOpen.values()].sort(
    (a, b) => new Date(a.time_open).getTime() - new Date(b.time_open).getTime(),
  );
}

export async function fetchPoolMeta(poolId: string) {
  const data = await fetchJson(`${BASE}/pools/${poolId}`);
  return data as {
    id: string;
    created_at: string;
    created_at_block_number: number;
    base_token_id: string;
    quote_token_id: string;
    tokens: Array<{ id: string; symbol: string; name: string }>;
    token_reserves?: Array<{ token_id: string; reserve: string; reserve_usd: number }>;
    liquidity_usd: number;
  };
}

/** Extract pool id from DexScreener URL path. */
export function poolIdFromDexUrl(url: string): string | undefined {
  const m = url.match(/dexscreener\.com\/robinhood\/(0x[a-fA-F0-9]+)/);
  return m?.[1];
}
