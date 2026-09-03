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
  deployments?: Array<{ contractAddress?: string; chainId?: number }>;
}

export interface StockRegistry {
  /** Lowercased official contract addresses. */
  addresses: Set<string>;
  /** Uppercased official symbols (NVDA, TSLA, …). */
  symbols: Set<string>;
}

let cached: { registry: StockRegistry; at: number } | undefined;

/** Undefined on fetch failure — callers fail open, matching the GoPlus gate. */
export async function fetchStockRegistry(): Promise<StockRegistry | undefined> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.registry;
  try {
    const res = await fetch(REGISTRY_URL, {
      headers: { "User-Agent": "foxhole-bot/0.3" },
    });
    if (!res.ok) throw new Error(`registry ${res.status}`);
    const data = (await res.json()) as { assets?: RhjAsset[] };
    const registry: StockRegistry = { addresses: new Set(), symbols: new Set() };
    for (const asset of data.assets ?? []) {
      if (asset.tokenSymbol) registry.symbols.add(asset.tokenSymbol.toUpperCase());
      for (const dep of asset.deployments ?? []) {
        if (dep.contractAddress) {
          registry.addresses.add(dep.contractAddress.toLowerCase());
        }
      }
    }
    // An empty registry means the API shape changed, not that no stocks exist.
    if (!registry.addresses.size) return cached?.registry;
    cached = { registry, at: Date.now() };
    return registry;
  } catch (err) {
    console.error("RH stock registry fetch failed:", (err as Error).message);
    return cached?.registry;
  }
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
