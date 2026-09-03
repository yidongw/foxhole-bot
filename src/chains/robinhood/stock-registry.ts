/**
 * Official Robinhood tokenized-stock registry (api.robinhood.com/rhj/assets,
 * public, no auth). Scam pattern (mmk_btc thread, 2026-09, $JINQIAN): an RB
 * "stock-backed" meme pool pairs against a token whose SYMBOL matches a US
 * stock but whose ADDRESS is not in the registry — the backing is a lookalike
 * ERC-20 the deployer minted. Only the address proves anything.
 *
 * Every official deployment lives on Robinhood Chain (4663) only, so a
 * stock-symbol quote token on any other chain is fake by definition.
 */

const REGISTRY_URL = "https://api.robinhood.com/rhj/assets";
const CACHE_TTL_MS = 6 * 3_600_000;

interface RhjAsset {
  tokenSymbol?: string;
  tokenName?: string;
  deployments?: Array<{ contractAddress?: string; chainId?: number }>;
}

export interface StockAsset {
  symbol: string;
  name?: string;
  /** Lowercased official contract address (first deployment). */
  address?: string;
}

export interface StockRegistry {
  /** Lowercased official contract addresses. */
  addresses: Set<string>;
  /** Uppercased official symbols (NVDA, TSLA, …). */
  symbols: Set<string>;
}

let assetCache: { assets: StockAsset[]; at: number } | undefined;

/** Detailed asset list — undefined on fetch failure (callers fail open). */
export async function fetchStockAssets(): Promise<StockAsset[] | undefined> {
  if (assetCache && Date.now() - assetCache.at < CACHE_TTL_MS) {
    return assetCache.assets;
  }
  try {
    const res = await fetch(REGISTRY_URL, {
      headers: { "User-Agent": "foxhole-bot/0.3" },
    });
    if (!res.ok) throw new Error(`registry ${res.status}`);
    const data = (await res.json()) as { assets?: RhjAsset[] };
    const assets: StockAsset[] = [];
    for (const a of data.assets ?? []) {
      if (!a.tokenSymbol) continue;
      assets.push({
        symbol: a.tokenSymbol.toUpperCase(),
        name: a.tokenName,
        address: a.deployments?.[0]?.contractAddress?.toLowerCase(),
      });
    }
    // An empty list means the API shape changed, not that no stocks exist.
    if (!assets.length) return assetCache?.assets;
    assetCache = { assets, at: Date.now() };
    return assets;
  } catch (err) {
    console.error("RH stock registry fetch failed:", (err as Error).message);
    return assetCache?.assets;
  }
}

/** Address/symbol sets for the fake-stock veto — undefined on fetch failure. */
export async function fetchStockRegistry(): Promise<StockRegistry | undefined> {
  const assets = await fetchStockAssets();
  if (!assets) return undefined;
  const registry: StockRegistry = { addresses: new Set(), symbols: new Set() };
  for (const a of assets) {
    registry.symbols.add(a.symbol);
    if (a.address) registry.addresses.add(a.address);
  }
  return registry;
}

export type StockQuoteVerdict = "official" | "fake" | "not_stock" | "unknown";

/**
 * Pure classification — exported for tests. Exact case-insensitive symbol
 * match only: a token named exactly like a registry stock must have the
 * registry address. Variant symbols (METAX, NVDAx3L…) are left alone — a
 * hard veto must not fire on legitimately different assets.
 */
export function classifyStockQuote(
  symbol: string | undefined,
  address: string | undefined,
  chain: string,
  registry: StockRegistry | undefined,
): StockQuoteVerdict {
  if (!registry) return "unknown";
  if (
    chain === "robinhood" &&
    address &&
    registry.addresses.has(address.toLowerCase())
  ) {
    return "official";
  }
  if (!symbol || !registry.symbols.has(symbol.toUpperCase())) return "not_stock";
  // Symbol claims a registry stock, address doesn't back it up — and off
  // Robinhood Chain no address can, since official deployments are 4663-only.
  return "fake";
}
