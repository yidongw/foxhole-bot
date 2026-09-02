import type { Address } from "viem";

import { analyzeToken } from "../long/analyze-token.js";
import { fetchTokenPriceUsd, fetchTrendingTokens } from "../dex/dexscreener.js";
import { buy as hoodBuy, sell as hoodSell } from "../trade/execute.js";
import type { ChainAdapter, ChainId } from "./adapter.js";
import { analyzeTokenGeneric } from "./generic-analysis.js";

const robinhoodAdapter: ChainAdapter = {
  id: "robinhood",
  displayName: "Robinhood Chain",
  // Robinhood discovery runs its own richer path (factory watcher + stock
  // search) inside the monitor; trending here is a supplement.
  trendingCandidates: async () =>
    (await fetchTrendingTokens("robinhood")).map((t) => t.tokenAddress),
  analyze: (address) => analyzeToken(address),
  priceUsd: (address) => fetchTokenPriceUsd(address, "robinhood"),
  buy: (token, priceUsd, usd, config) =>
    hoodBuy(config, token as Address, priceUsd, usd),
  sell: (position, fraction, currentPriceUsd, config) =>
    hoodSell(config, position, fraction, currentPriceUsd),
};

function genericAdapter(id: ChainId, displayName: string): ChainAdapter {
  return {
    id,
    displayName,
    trendingCandidates: async () =>
      (await fetchTrendingTokens(id)).map((t) => t.tokenAddress),
    analyze: (address) => analyzeTokenGeneric(id, address),
    priceUsd: (address) => fetchTokenPriceUsd(address, id),
    // No live execution yet (P1+); paper mode works through the engine.
  };
}

const ADAPTERS: Record<ChainId, ChainAdapter> = {
  robinhood: robinhoodAdapter,
  solana: genericAdapter("solana", "Solana"),
  bsc: genericAdapter("bsc", "BNB Chain"),
  base: genericAdapter("base", "Base"),
  ethereum: genericAdapter("ethereum", "Ethereum"),
};

export function getAdapter(id: ChainId): ChainAdapter {
  return ADAPTERS[id];
}

export function positionChain(chain: string | undefined): ChainId {
  return (chain ?? "robinhood") as ChainId;
}
