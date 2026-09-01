import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { searchPairs, fetchTokenPairs } from "../dex/dexscreener.js";
import {
  LONG_AIRLOCK,
  LONG_FACTORY,
  ROBINHOOD_CHAIN_ID,
  SEARCH_QUERIES,
} from "../long/constants.js";
import { isStockQuote, sleep } from "../lib/utils.js";
import type { DexPair, LaunchRecord, LaunchesPayload } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

function mergePair(seen: Map<string, LaunchRecord>, pair: DexPair) {
  const base = pair.baseToken;
  const quote = pair.quoteToken;
  const address = base?.address?.toLowerCase();
  const quoteSymbol = quote?.symbol ?? "";
  if (!address || !isStockQuote(quoteSymbol)) return;

  const vol = Number(pair.volume?.h24 ?? 0);
  const liq = Number(pair.liquidity?.usd ?? 0);
  const fdv = Number(pair.fdv ?? 0);
  const created = pair.pairCreatedAt;
  const txns =
    Number(pair.txns?.h24?.buys ?? 0) + Number(pair.txns?.h24?.sells ?? 0);

  const existing = seen.get(address);
  if (!existing) {
    seen.set(address, {
      address: base!.address!,
      name: base?.name,
      symbol: base?.symbol,
      pair: `${base?.symbol}/${quoteSymbol}`,
      quote_symbol: quoteSymbol,
      quote_address: quote?.address,
      fdv,
      liquidity_usd: liq,
      volume_24h: vol,
      price_usd: Number(pair.priceUsd ?? 0),
      price_change_24h: pair.priceChange?.h24,
      pair_created_at: created ?? null,
      dex_url: pair.url,
      labels: pair.labels ?? [],
      txns_24h: txns,
      long_url: `https://app.long.xyz/tokens/${base!.address}`,
      explorer_url: `https://robinhoodchain.blockscout.com/token/${base!.address}`,
      source: "dexscreener",
      launchpad: "long.xyz",
    });
    return;
  }

  existing.volume_24h = Math.max(existing.volume_24h, vol);
  existing.liquidity_usd = Math.max(existing.liquidity_usd, liq);
  existing.fdv = Math.max(existing.fdv, fdv);
  existing.txns_24h = Math.max(existing.txns_24h, txns);
  if (created && (!existing.pair_created_at || created < existing.pair_created_at)) {
    existing.pair_created_at = created;
  }
}

async function backfillLaunchTime(item: LaunchRecord): Promise<void> {
  if (item.pair_created_at) return;
  const pairs = await fetchTokenPairs(item.address);
  let earliest: number | undefined;
  for (const p of pairs) {
    if (p.pairCreatedAt && (!earliest || p.pairCreatedAt < earliest)) {
      earliest = p.pairCreatedAt;
    }
  }
  if (earliest) {
    item.pair_created_at = earliest;
    item.launch_time_source = "dexscreener_token_pairs";
  }
}

export async function collectLaunches(): Promise<LaunchesPayload> {
  const seen = new Map<string, LaunchRecord>();

  for (const query of SEARCH_QUERIES) {
    const pairs = await searchPairs(query);
    for (const pair of pairs) mergePair(seen, pair);
    await sleep(150);
  }

  const launches = [...seen.values()];
  for (const item of launches) {
    await backfillLaunchTime(item);
    if (item.pair_created_at) {
      item.created_at = new Date(item.pair_created_at).toISOString();
    }
    await sleep(100);
  }

  launches.sort((a, b) => (b.pair_created_at ?? 0) - (a.pair_created_at ?? 0));

  const quoteBreakdown: Record<string, number> = {};
  let totalVolume = 0;
  let totalLiquidity = 0;
  for (const l of launches) {
    quoteBreakdown[l.quote_symbol] = (quoteBreakdown[l.quote_symbol] ?? 0) + 1;
    totalVolume += l.volume_24h;
    totalLiquidity += l.liquidity_usd;
  }

  return {
    meta: {
      fetched_at: new Date().toISOString(),
      chain: "robinhood",
      chain_id: ROBINHOOD_CHAIN_ID,
      launchpad: "long.xyz",
      factory: LONG_FACTORY,
      airlock: LONG_AIRLOCK,
      source: "dexscreener stock-paired discovery",
      count: launches.length,
      quote_breakdown: Object.fromEntries(
        Object.entries(quoteBreakdown).sort((a, b) => b[1] - a[1]),
      ),
      total_volume_24h_usd: Math.round(totalVolume * 100) / 100,
      total_liquidity_usd: Math.round(totalLiquidity * 100) / 100,
    },
    launches,
  };
}

export async function writeLaunchesJson(payload: LaunchesPayload): Promise<void> {
  const json = JSON.stringify(payload, null, 2);
  const targets = [
    path.join(ROOT, "data", "launches.json"),
    path.join(ROOT, "web", "data", "launches.json"),
  ];
  for (const target of targets) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, json, "utf8");
    console.log(`wrote ${target} (${payload.launches.length} launches)`);
  }
}
