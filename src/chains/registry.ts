import type { Address } from "viem";

import { analyzeToken } from "../long/analyze-token.js";
import { fetchTokenPriceUsd, fetchTrendingTokens } from "../dex/dexscreener.js";
import { buy as hoodBuy, sell as hoodSell } from "../trade/execute.js";
import type { ChainAdapter, ChainId } from "./adapter.js";
import { analyzeTokenGeneric } from "./generic-analysis.js";
import { v2Buy, v2Sell } from "./evm/v2-swap.js";
import { getFourmemeCurveState } from "./bsc/fourmeme.js";
import { getPumpCurveState } from "./solana/pumpfun.js";
import { fetchMoverCandidates } from "../review/movers.js";
import { jupiterBuy, jupiterSell } from "./solana/jupiter.js";

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
    // Two discovery feeds: DexScreener boosts (promoted) + DexPaprika top
    // movers (actual 暴涨) — the movers feed exists to close coverage misses.
    trendingCandidates: async () => {
      const [boosted, movers] = await Promise.all([
        fetchTrendingTokens(id).then((t) => t.map((x) => x.tokenAddress)),
        fetchMoverCandidates(id),
      ]);
      const seen = new Set<string>();
      return [...movers, ...boosted].filter((a) => {
        const k = a.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    },
    analyze: (address) => analyzeTokenGeneric(id, address),
    priceUsd: (address) => fetchTokenPriceUsd(address, id),
    // No live execution yet (P1+); paper mode works through the engine.
  };
}

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

// BSC: generic discovery/analysis + four.meme bonding-curve extras +
// PancakeSwap v2 live execution.
// ⚠️ Live path untested with real funds — paper first (see README).
const bscAdapter: ChainAdapter = {
  ...genericAdapter("bsc", "BNB Chain"),
  analyze: async (address) => {
    // Read the four.meme curve first: on-curve tokens have real BNB depth
    // that DexScreener reports as null liquidity, so we need it to survive
    // the signal engine's liquidity gate.
    const curve = await getFourmemeCurveState(address).catch(
      () => ({ isFourmemeToken: false }) as Awaited<
        ReturnType<typeof getFourmemeCurveState>
      >,
    );
    const analysis = await analyzeTokenGeneric("bsc", address);
    if (curve.isFourmemeToken) {
      analysis.curveProgress = curve.progress;
      analysis.curveGraduated = curve.graduated;
      if (curve.graduated) {
        analysis.signals.push("four.meme: graduated to PancakeSwap");
      } else {
        if (curve.progress != null) {
          analysis.signals.push(
            `four.meme curve ${(curve.progress * 100).toFixed(0)}% to graduation`,
          );
        }
        // Curve funds (BNB raised) are the token's real economic depth pre-
        // graduation — surface them as liquidity so near-graduation tokens
        // clear the min-liquidity gate.
        if (curve.fundsRaised && (analysis.liquidityUsd ?? 0) <= 0) {
          const bnb = await fetchTokenPriceUsd(WBNB, "bsc").catch(
            () => undefined,
          );
          if (bnb) analysis.liquidityUsd = curve.fundsRaised * bnb;
        }
      }
    }
    return analysis;
  },
  buy: async (token, priceUsd, usd, config) =>
    v2Buy("bsc", token as Address, usd, config.slippageBps),
  sell: async (position, fraction, _currentPriceUsd, config) =>
    v2Sell(
      "bsc",
      position.token as Address,
      position.amountTokens * fraction,
      config.slippageBps,
    ),
};

// Base: v2-router execution covers v2-pooled tokens; Clanker v4-pool-only
// tokens have no v2 route and will revert on quote (surfaced, not swallowed).
const baseAdapter: ChainAdapter = {
  ...genericAdapter("base", "Base"),
  buy: async (token, priceUsd, usd, config) =>
    v2Buy("base", token as Address, usd, config.slippageBps),
  sell: async (position, fraction, _currentPriceUsd, config) =>
    v2Sell(
      "base",
      position.token as Address,
      position.amountTokens * fraction,
      config.slippageBps,
    ),
};

// Solana: generic analysis + pump.fun curve extras; Jupiter live execution.
// ⚠️ Live path untested with real funds — paper first (see README).
const solanaAdapter: ChainAdapter = {
  ...genericAdapter("solana", "Solana"),
  analyze: async (address) => {
    const analysis = await analyzeTokenGeneric("solana", address);
    const curve = await getPumpCurveState(address);
    if (curve.isPumpToken) {
      analysis.curveProgress = curve.progress;
      analysis.curveGraduated = curve.graduated;
      if (curve.graduated) analysis.signals.push("pump.fun: graduated to AMM");
      else if (curve.progress != null) {
        analysis.signals.push(
          `pump.fun curve ${(curve.progress * 100).toFixed(0)}% to graduation`,
        );
      }
    }
    return analysis;
  },
  buy: async (token, _priceUsd, usd, config) =>
    jupiterBuy(token, usd, config.slippageBps),
  sell: async (position, fraction, _currentPriceUsd, config) =>
    jupiterSell(
      position.token,
      position.amountTokens * fraction,
      config.slippageBps,
    ),
};

const ADAPTERS: Record<ChainId, ChainAdapter> = {
  robinhood: robinhoodAdapter,
  solana: solanaAdapter,
  bsc: bscAdapter,
  base: baseAdapter,
  ethereum: genericAdapter("ethereum", "Ethereum"),
};

export function getAdapter(id: ChainId): ChainAdapter {
  return ADAPTERS[id];
}

export function positionChain(chain: string | undefined): ChainId {
  return (chain ?? "robinhood") as ChainId;
}
