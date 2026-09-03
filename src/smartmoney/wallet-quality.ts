import {
  GmgnError,
  gmgnPortfolioStats,
  gmgnWalletActivity,
  type GmgnStats,
} from "./gmgn.js";

/**
 * Stage-2 of the winner-finder: decide whether a wallet is WORTH TRACKING —
 * i.e. its future buys are a useful, copyable signal — not just that it made
 * money on one token. Uses GMGN `portfolio stats` (overall track record) +
 * `portfolio activity` (entry sizes / mcap), never a single token's PnL.
 *
 * Reject rules (your spec):
 *   - win rate < 40%
 *   - trades too many distinct tokens (bot / spray-and-pray, un-copyable)
 *   - no repeatable upside (never caught a >2x → one-hit / churn)
 *   - avg buy too small (dust / bot)
 *   - median entry mcap outside $30k–$1M (snipers we can't follow / too late)
 *   - dormant, or bot/insider/arbitrager tags
 */

export interface WalletMetrics {
  winrate: number;
  tokenNum: number;
  realizedUsd: number;
  roi: number; // realized_profit_pnl
  bigWins: number; // tokens > 2x
  losers: number; // tokens with loss < -50%
  avgBuyUsd: number;
  medianEntryMcap: number;
  lastActiveDays: number;
  tags: string[];
}

export interface QualityConfig {
  minRoi: number;
  minWinrate: number;
  minTokens: number;
  maxTokens: number;
  minRealizedUsd: number;
  minBigWins: number;
  minAvgBuyUsd: number;
  entryMcapMin: number;
  entryMcapMax: number;
  maxIdleDays: number;
}

/**
 * Calibrated against live BSC meme data (牛来/marscoin): the top-profit wallets
 * are low-win-rate/high-turnover, so ROI (profit per $ spent) is the real skill
 * gate, not win rate. A 19%-winrate wallet with 3.4x ROI ($455k) is skilled; a
 * 37%-winrate arbitrager with 0.11x ROI is churn. Win rate is a low soft floor;
 * entry-mcap is a wide advisory band (its activity-derived estimate is noisy).
 */
export const DEFAULT_QUALITY: QualityConfig = {
  minRoi: 1.0, // core gate: realized ≥ 100% of cost spent
  minWinrate: 0.1, // noise floor only — ROI is the real skill gate for memes
  minTokens: 10,
  maxTokens: 400, // egregious spray only; bots also caught by tags
  minRealizedUsd: 5_000,
  minBigWins: 1, // caught at least one >2x
  minAvgBuyUsd: 200,
  entryMcapMin: 10_000,
  entryMcapMax: 5_000_000,
  maxIdleDays: 14,
};

const BAD_TAGS = new Set([
  "sandwich_bot",
  "mev_bot",
  "wash_trader",
  "bundler",
  "dev",
  "rat_trader",
  "dex_bot",
  "arbitrager",
]);

export interface QualityVerdict {
  pass: boolean;
  score: number; // 0..100
  tier: "S" | "A" | "B" | "-";
  reasons: string[];
  metrics: WalletMetrics;
}

/** Pure gate + score from computed metrics (unit-tested). */
export function scoreWallet(
  m: WalletMetrics,
  cfg: QualityConfig = DEFAULT_QUALITY,
): QualityVerdict {
  const fail: string[] = [];
  if (m.tags.some((t) => BAD_TAGS.has(t))) fail.push(`bad tag: ${m.tags.filter((t) => BAD_TAGS.has(t)).join(",")}`);
  if (m.roi < cfg.minRoi) fail.push(`ROI ${m.roi.toFixed(2)}x < ${cfg.minRoi}x`);
  if (m.winrate < cfg.minWinrate) fail.push(`winrate ${(m.winrate * 100).toFixed(0)}% < ${cfg.minWinrate * 100}%`);
  if (m.tokenNum > cfg.maxTokens) fail.push(`${m.tokenNum} tokens > ${cfg.maxTokens} (bot-like)`);
  if (m.tokenNum < cfg.minTokens) fail.push(`only ${m.tokenNum} tokens (no history)`);
  if (m.realizedUsd < cfg.minRealizedUsd) fail.push(`realized $${Math.round(m.realizedUsd)} < $${cfg.minRealizedUsd}`);
  if (m.bigWins < cfg.minBigWins) fail.push(`no >2x wins`);
  if (m.avgBuyUsd > 0 && m.avgBuyUsd < cfg.minAvgBuyUsd) fail.push(`avg buy $${Math.round(m.avgBuyUsd)} < $${cfg.minAvgBuyUsd}`);
  if (m.medianEntryMcap > 0 && (m.medianEntryMcap < cfg.entryMcapMin || m.medianEntryMcap > cfg.entryMcapMax))
    fail.push(`entry mcap $${Math.round(m.medianEntryMcap).toLocaleString()} outside band`);
  if (m.lastActiveDays > cfg.maxIdleDays) fail.push(`idle ${m.lastActiveDays.toFixed(0)}d`);

  // Score (meaningful when it passes): ROI-led, then upside, win rate, focus.
  const roiPts = Math.min(45, Math.max(0, m.roi) * 15);
  const upsidePts = Math.min(25, m.bigWins * 5);
  const winPts = Math.min(20, m.winrate * 40);
  const focusPts = m.tokenNum <= 60 ? 10 : m.tokenNum <= 150 ? 5 : 0;
  const score = Math.round(roiPts + upsidePts + winPts + focusPts);

  const pass = fail.length === 0;
  const tier: QualityVerdict["tier"] = !pass
    ? "-"
    : score >= 70
      ? "S"
      : score >= 50
        ? "A"
        : "B";
  return { pass, score, tier, reasons: fail, metrics: m };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Compute metrics from GMGN stats + activity. */
export function metricsFrom(
  stats: GmgnStats,
  buys: { costUsd: number; entryMcap: number }[],
  nowSec: number,
): WalletMetrics {
  const p = stats.pnl_stat;
  const costs = buys.map((b) => b.costUsd).filter((x) => x > 0);
  const mcaps = buys.map((b) => b.entryMcap).filter((x) => x > 0);
  return {
    winrate: p.winrate,
    tokenNum: p.token_num,
    realizedUsd: stats.realized_profit,
    roi: stats.realized_profit_pnl,
    bigWins: p.pnl_2x_5x_num + p.pnl_gt_5x_num,
    losers: p.pnl_lt_nd5_num,
    avgBuyUsd: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0,
    medianEntryMcap: median(mcaps),
    lastActiveDays: stats.last_timestamp ? (nowSec - stats.last_timestamp) / 86_400 : 999,
    tags: stats.tags,
  };
}

/** Full IO assessment: pull stats + activity, compute metrics, score. */
export async function assessWallet(
  chain: string,
  wallet: string,
  nowSec: number,
  cfg: QualityConfig = DEFAULT_QUALITY,
): Promise<QualityVerdict | undefined> {
  let stats: GmgnStats | undefined;
  try {
    stats = await gmgnPortfolioStats(chain, wallet, "30d");
  } catch (err) {
    if (err instanceof GmgnError && err.rateLimited) throw err;
    return undefined;
  }
  if (!stats) return undefined;

  let buys: { costUsd: number; entryMcap: number }[] = [];
  try {
    const acts = await gmgnWalletActivity(chain, wallet, { limit: 30 });
    buys = acts
      .filter((a) => a.event_type === "buy")
      .map((a) => {
        const price = Number(a.price_usd ?? 0);
        const supply = Number(a.token.total_supply ?? 0);
        return { costUsd: Number(a.cost_usd ?? 0), entryMcap: price * supply };
      });
  } catch {
    // activity is best-effort; entry-mcap/avg-buy gates just skip when absent
  }

  return scoreWallet(metricsFrom(stats, buys, nowSec), cfg);
}
