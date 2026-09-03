/**
 * Per-chain Discord routing. Resolution order:
 *   1. DISCORD_<KIND>_WEBHOOK_URL_<CHAIN>   (e.g. DISCORD_SIGNAL_WEBHOOK_URL_SOLANA)
 *   2. DISCORD_<KIND>_WEBHOOK_URL           (global for that kind)
 *   3. kind-specific legacy fallback        (signal → DISCORD_WEBHOOK_URL)
 *
 * Kinds: signal (交易触发) · trade (交易日志) · filter (过滤日志) ·
 *        review (复盘确认) · feed (完整流水, default off) ·
 *        news (新闻雷达 — BlockBeats 备考/留痕, default off)
 */

export type RouteKind =
  | "signal"
  | "trade"
  | "filter"
  | "review"
  | "feed"
  | "news"
  | "smartmoney";

const KIND_ENV: Record<RouteKind, string> = {
  signal: "DISCORD_SIGNAL_WEBHOOK_URL",
  trade: "DISCORD_TRADE_WEBHOOK_URL",
  filter: "DISCORD_FILTER_WEBHOOK_URL",
  review: "DISCORD_REVIEW_WEBHOOK_URL",
  feed: "DISCORD_FEED_WEBHOOK_URL",
  news: "DISCORD_NEWS_WEBHOOK_URL",
  smartmoney: "DISCORD_SMARTMONEY_WEBHOOK_URL",
};

const LEGACY_FALLBACK: Partial<Record<RouteKind, string>> = {
  signal: "DISCORD_WEBHOOK_URL",
  review: "DISCORD_FILTER_WEBHOOK_URL", // review defaults into the filter channel
};

export function resolveWebhook(kind: RouteKind, chain?: string): string | undefined {
  const base = KIND_ENV[kind];
  if (chain) {
    const perChain = process.env[`${base}_${chain.toUpperCase()}`];
    if (perChain) return perChain;
  }
  const global = process.env[base];
  if (global) return global;
  const legacy = LEGACY_FALLBACK[kind];
  if (legacy && process.env[legacy]) return process.env[legacy];
  // trade/filter historically fell back to the main webhook; feed stays off
  if (kind === "trade" || kind === "filter") return process.env.DISCORD_WEBHOOK_URL;
  return undefined;
}
