import { GmgnError } from "./gmgn.js";
import { coarseScore, qualifyWallet, topTraders } from "./profit.js";
import {
  assessWallet,
  DEFAULT_QUALITY,
  type QualityConfig,
  type QualityVerdict,
} from "./wallet-quality.js";

/**
 * Winner-finder v2 — "wallets worth tracking", not "top profit on one token".
 *
 * Two stages:
 *   1. Coarse (cheap): each good token's top traders → drop bots/insiders/
 *      pure-paper (qualifyWallet) → a small candidate pool, remembering which
 *      good tokens each wallet won on.
 *   2. Deep (per wallet): pull the wallet's OVERALL track record + entry sizes
 *      (assessWallet) → win rate ≥40%, not too many tokens, caught a >2x,
 *      copyable entry mcap $30k–$1M, still active. Cross-token winners (pass on
 *      ≥2 independent good tokens) are promoted to tier S.
 */

export interface WorthTrackingCandidate {
  address: string;
  tier: "S" | "A" | "B";
  score: number;
  crossTokens: string[];
  verdict: QualityVerdict;
}

export interface FindOpts {
  coarsePerToken?: number;
  maxDeep?: number;
  delayMs?: number;
  coarseMinRealizedUsd?: number;
  quality?: QualityConfig;
  nowSec?: number;
  onProgress?: (msg: string) => void;
}

export async function findWorthTracking(
  chain: string,
  tokens: { address: string; label?: string }[],
  opts: FindOpts = {},
): Promise<{ candidates: WorthTrackingCandidate[]; log: string[] }> {
  const coarsePerToken = opts.coarsePerToken ?? 40;
  const maxDeep = opts.maxDeep ?? 50;
  const delayMs = opts.delayMs ?? 1_500;
  const quality = opts.quality ?? DEFAULT_QUALITY;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const log: string[] = [];
  const note = (m: string) => {
    log.push(m);
    opts.onProgress?.(m);
  };

  // --- Stage 1: coarse pool with cross-token memory ---
  const pool = new Map<string, { tokens: Set<string>; realized: number }>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const name = t.label ?? t.address.slice(0, 8);
    try {
      // Pull the FULL trader list, drop bots/insiders/pure-paper, then rank by
      // ROI + quality (coarseScore) — NOT raw profit, which surfaces the
      // high-frequency arbitragers that win on volume but aren't copyable.
      const { wallets } = await topTraders(chain, t.address, 100);
      const survivors = wallets
        .filter((w) => qualifyWallet(w, opts.coarseMinRealizedUsd ?? 5_000))
        .sort((a, b) => coarseScore(b) - coarseScore(a))
        .slice(0, coarsePerToken);
      for (const w of survivors) {
        const a = w.address.toLowerCase();
        const e = pool.get(a) ?? { tokens: new Set<string>(), realized: 0 };
        e.tokens.add(name);
        e.realized = Math.max(e.realized, w.realizedUsd ?? 0);
        pool.set(a, e);
      }
      note(`coarse [${name}]: ${survivors.length} candidates (ROI-ranked of ${wallets.length})`);
    } catch (err) {
      note(`coarse [${name}]: ERR ${(err as Error).message.slice(0, 60)}`);
    }
    if (delayMs && i < tokens.length - 1) await sleep(delayMs);
  }

  // Prioritise cross-token, then coarse realized, and cap the deep pass.
  const ranked = [...pool.entries()].sort(
    (a, b) => b[1].tokens.size - a[1].tokens.size || b[1].realized - a[1].realized,
  );
  const toAssess = ranked.slice(0, maxDeep);
  note(`deep-assessing ${toAssess.length}/${ranked.length} unique candidates`);

  // --- Stage 2: deep per-wallet quality ---
  const out: WorthTrackingCandidate[] = [];
  for (let i = 0; i < toAssess.length; i++) {
    const [addr, meta] = toAssess[i];
    try {
      const verdict = await assessWallet(chain, addr, nowSec, quality);
      if (verdict?.pass) {
        const crossTokens = [...meta.tokens];
        // Cross-token corroboration → tier S.
        const tier = crossTokens.length >= 2 ? "S" : verdict.tier === "-" ? "B" : verdict.tier;
        out.push({ address: addr, tier, score: verdict.score, crossTokens, verdict });
      }
    } catch (err) {
      if (err instanceof GmgnError && err.rateLimited) await sleep(6_000);
    }
    if (delayMs && i < toAssess.length - 1) await sleep(delayMs);
  }

  out.sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || b.score - a.score);
  note(`worth-tracking: ${out.length} passed deep filter`);
  return { candidates: out, log };
}

function tierRank(t: string): number {
  return t === "S" ? 3 : t === "A" ? 2 : t === "B" ? 1 : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
