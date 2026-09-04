import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { selectDeepestBasePair } from "../chains/generic-analysis.js";
import { fetchTokenPairs } from "../dex/dexscreener.js";
import { writeJsonAtomic } from "../lib/atomic-json.js";
import { loadPositions, type Position } from "../trade/positions.js";
import type { ClassifiedMover } from "./movers.js";

/**
 * 自我出场复盘 — the review loop grading OUR OWN trades, not just alerts.
 *
 * Two blind spots this closes (2026-09-04, user caught both by hand):
 * - 卖飞: NUDES was scratch-closed by an over-eager trail stop, then 10x'd.
 *   Nothing in the review ever looked back at closed positions.
 * - 报了没买: FATCOIN alerted, the decider skipped it, it flew. Alerted
 *   movers are filtered OUT of the miss-candidate list (kind === "alerted"),
 *   so a skip-then-pump was invisible.
 * Each finding is reported once (state file dedup) so the hourly schedule
 * doesn't repeat itself.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(
  __dirname,
  "../../data/outcomes/exit-review-state.json",
);

/** Only look back this far — older exits were either flagged already or moot. */
const WINDOW_MS = 72 * 3_600_000;
/** Current price ≥ this × our average exit price counts as 卖飞. */
const FLY_MULTIPLE = 2;
/** Alerted-but-never-bought movers must be up at least this much (pct). */
const NEVER_BOUGHT_MIN_CHANGE = 100;

export interface SoldTooEarly {
  positionId: string;
  symbol?: string;
  chain: string;
  token: string;
  avgExitPriceUsd: number;
  currentPriceUsd: number;
  multiple: number;
  exitReasons: string[];
  realizedPnlUsd: number;
}

export interface NeverBought {
  symbol?: string;
  chain: string;
  address: string;
  priceChange24h: number;
  /** Gain since OUR first alert — the honest miss metric; 24h% is a rolling
   *  window unrelated to the decision point (it once showed "+9073%" for a
   *  token that was ~3x since the actual skip). */
  sinceAlertPct?: number;
  alertPriceUsd?: number;
  currentPriceUsd?: number;
  safetyFlags?: string[];
}

export interface LessonEntry {
  at: string;
  kind: "sold_too_early" | "never_bought";
  symbol?: string;
  chain: string;
  detail: string;
}

interface ExitReviewState {
  flaggedPositions: string[];
  flaggedTokens: string[];
  /** Rolling log of findings so the AI 巡检/decider can read recent lessons. */
  lessons?: LessonEntry[];
}

/** Keep this many findings for the status "近期教训" section. */
const LESSONS_KEPT = 30;
/** Lessons older than this stop showing in status output. */
const LESSONS_WINDOW_MS = 7 * 24 * 3_600_000;

/** Proceeds-weighted average exit price; undefined until something was sold. */
export function avgExitPriceUsd(position: Position): number | undefined {
  let proceeds = 0;
  let tokensSold = 0;
  for (const e of position.exits) {
    proceeds += e.proceedsUsd;
    tokensSold += e.fraction * position.amountTokens;
  }
  return tokensSold > 0 ? proceeds / tokensSold : undefined;
}

export function realizedPnlUsd(position: Position): number {
  return (
    position.exits.reduce((sum, e) => sum + e.proceedsUsd, 0) - position.costUsd
  );
}

/** Compact "which mechanism sold" summary, e.g. "trail stop ×2, manual exit". */
export function exitReasonSummary(position: Position): string[] {
  const counts = new Map<string, number>();
  for (const e of position.exits) {
    const kind = e.reason.split(":")[0].trim();
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()].map(([kind, n]) =>
    n > 1 ? `${kind} ×${n}` : kind,
  );
}

async function loadState(): Promise<ExitReviewState> {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8")) as ExitReviewState;
  } catch {
    return { flaggedPositions: [], flaggedTokens: [] };
  }
}

/** First alert-time price per token address from the inbox archives, so
 *  报了没买 anchors to our decision point instead of the rolling 24h change. */
async function loadAlertPrices(): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  for (const name of ["ai-inbox-processed.jsonl", "ai-inbox.jsonl"]) {
    try {
      const raw = await readFile(
        path.resolve(__dirname, "../../data", name),
        "utf8",
      );
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const it = JSON.parse(line) as { address?: string; priceUsd?: number };
          if (!it.address || !it.priceUsd || it.priceUsd <= 0) continue;
          const key = it.address.toLowerCase();
          if (!prices.has(key)) prices.set(key, it.priceUsd);
        } catch {
          /* skip unparseable line */
        }
      }
    } catch {
      /* archive missing is fine */
    }
  }
  return prices;
}

export interface OwnTradeReview {
  soldTooEarly: SoldTooEarly[];
  neverBought: NeverBought[];
  /** Ready-to-post report lines; empty when nothing new to confess. */
  lines: string[];
}

export async function reviewOwnTrades(
  movers: ClassifiedMover[],
  now: Date = new Date(),
): Promise<OwnTradeReview> {
  const state = await loadState();
  const file = await loadPositions();

  const soldTooEarly: SoldTooEarly[] = [];
  const recentClosed = file.positions.filter((p) => {
    if (p.status !== "closed" || !p.exits.length) return false;
    const lastExit = new Date(p.exits[p.exits.length - 1].at).getTime();
    return now.getTime() - lastExit <= WINDOW_MS;
  });
  for (const p of recentClosed) {
    if (state.flaggedPositions.includes(p.id)) continue;
    const avgExit = avgExitPriceUsd(p);
    if (!avgExit || avgExit <= 0) continue;
    const chain = p.chain ?? "robinhood";
    let current: number | undefined;
    try {
      const pairs = await fetchTokenPairs(p.token, chain);
      const primary = selectDeepestBasePair(pairs, p.token);
      if (primary?.priceUsd) current = Number(primary.priceUsd);
    } catch (err) {
      console.error(`exit review price fetch failed ${p.symbol}:`, (err as Error).message);
    }
    if (!current || current <= 0) continue;
    const multiple = current / avgExit;
    if (multiple < FLY_MULTIPLE) continue;
    soldTooEarly.push({
      positionId: p.id,
      symbol: p.symbol,
      chain,
      token: p.token,
      avgExitPriceUsd: avgExit,
      currentPriceUsd: current,
      multiple,
      exitReasons: exitReasonSummary(p),
      realizedPnlUsd: realizedPnlUsd(p),
    });
    state.flaggedPositions.push(p.id);
  }

  // 报了没买: alerted movers that pumped, where we never held a position.
  const held = new Set(file.positions.map((p) => p.token.toLowerCase()));
  const alertPrices = await loadAlertPrices();
  const neverBought: NeverBought[] = [];
  for (const m of movers) {
    if (m.kind !== "alerted") continue;
    if (m.priceChange24h < NEVER_BOUGHT_MIN_CHANGE) continue;
    if (m.ladder || m.noData) continue;
    if (held.has(m.address.toLowerCase())) continue;
    const key = `${m.chain}:${m.address.toLowerCase()}`;
    if (state.flaggedTokens.includes(key)) continue;
    const alertPrice = alertPrices.get(m.address.toLowerCase());
    let sinceAlertPct: number | undefined;
    let current: number | undefined;
    if (alertPrice) {
      try {
        const pairs = await fetchTokenPairs(m.address, m.chain);
        const primary = selectDeepestBasePair(pairs, m.address);
        if (primary?.priceUsd) current = Number(primary.priceUsd);
      } catch {
        /* fall through to the 24h anchor */
      }
      if (current && current > 0) {
        sinceAlertPct = (current / alertPrice - 1) * 100;
        // Flat-or-down since our decision point = not actually a miss; leave
        // it unflagged so a later real pump can still surface it.
        if (sinceAlertPct < NEVER_BOUGHT_MIN_CHANGE) continue;
      }
    }
    neverBought.push({
      symbol: m.symbol,
      chain: m.chain,
      address: m.address,
      priceChange24h: m.priceChange24h,
      sinceAlertPct,
      alertPriceUsd: alertPrice,
      currentPriceUsd: current,
      safetyFlags: m.safetyFlags,
    });
    state.flaggedTokens.push(key);
  }

  if (soldTooEarly.length || neverBought.length) {
    const lessons = state.lessons ?? [];
    for (const s of soldTooEarly) {
      lessons.push({
        at: now.toISOString(),
        kind: "sold_too_early",
        symbol: s.symbol,
        chain: s.chain,
        detail: `出场均价 $${s.avgExitPriceUsd.toPrecision(3)} → 现价 ${s.multiple.toFixed(1)}x, 出场机制: ${s.exitReasons.join(", ")}, 实现 ${s.realizedPnlUsd >= 0 ? "+" : ""}$${s.realizedPnlUsd.toFixed(2)}`,
      });
    }
    for (const n of neverBought) {
      lessons.push({
        at: now.toISOString(),
        kind: "never_bought",
        symbol: n.symbol,
        chain: n.chain,
        detail:
          n.sinceAlertPct != null && n.alertPriceUsd != null
            ? `警报后未开仓, 自警报价 $${n.alertPriceUsd.toPrecision(3)} 涨 +${n.sinceAlertPct.toFixed(0)}%${n.safetyFlags?.length ? ` (安全门: ${n.safetyFlags.join(",")})` : ""}`
            : `警报后未开仓, 24h口径 +${n.priceChange24h.toFixed(0)}% (无警报价)${n.safetyFlags?.length ? ` (安全门: ${n.safetyFlags.join(",")})` : ""}`,
      });
    }
    state.lessons = lessons.slice(-LESSONS_KEPT);
    await writeJsonAtomic(STATE_PATH, state);
  }

  const lines: string[] = [];
  if (soldTooEarly.length || neverBought.length) {
    lines.push("", "**🪞 自我出场复盘（我们自己的单，不是市场的）:**");
  }
  for (const s of soldTooEarly) {
    lines.push(
      `  🏃 卖飞 ${s.symbol ?? s.token.slice(0, 10)} [${s.chain}] ` +
        `出场均价 $${s.avgExitPriceUsd.toPrecision(3)} → 现价 $${s.currentPriceUsd.toPrecision(3)} ` +
        `(${s.multiple.toFixed(1)}x) — 出场机制: ${s.exitReasons.join(", ")}, ` +
        `实现 ${s.realizedPnlUsd >= 0 ? "+" : ""}$${s.realizedPnlUsd.toFixed(2)}`,
    );
  }
  for (const n of neverBought) {
    lines.push(
      `  🚫 报了没买 ${n.symbol ?? n.address.slice(0, 10)} [${n.chain}] ` +
        (n.sinceAlertPct != null && n.alertPriceUsd != null
          ? `自警报价 $${n.alertPriceUsd.toPrecision(3)} 涨 +${n.sinceAlertPct.toFixed(0)}%`
          : `24h口径 +${n.priceChange24h.toFixed(0)}%（无警报价）`) +
        (n.safetyFlags?.length ? `（安全门: ${n.safetyFlags.join(",")}）` : "（decider 跳过或未触发入场）"),
    );
  }
  if (lines.length) {
    lines.push(
      "  ↑ 查明机制是否误伤（决策时点数据，别拿现在倒推），误伤才改规则。",
    );
  }
  return { soldTooEarly, neverBought, lines };
}

/**
 * Recent lessons for the AI 巡检/decider — surfaced in `ai-trade status` so
 * the portfolio patrol sees its own past mistakes without any schedule-prompt
 * change. Empty string when there is nothing recent.
 */
export async function formatRecentLessons(now: Date = new Date()): Promise<string> {
  const state = await loadState();
  const recent = (state.lessons ?? []).filter(
    (l) => now.getTime() - new Date(l.at).getTime() <= LESSONS_WINDOW_MS,
  );
  if (!recent.length) return "";
  const tag = { sold_too_early: "🏃 卖飞", never_bought: "🚫 报了没买" } as const;
  return [
    "=== 🪞 近期教训（自我出场复盘, 7d）===",
    ...recent
      .slice(-10)
      .map(
        (l) =>
          `${tag[l.kind]} ${l.symbol ?? "?"} [${l.chain}] ${l.detail} (${l.at.slice(5, 16)})`,
      ),
    "决策时参考: 卖飞多=出场机制太紧; 报了没买多=跳过判断太保守。",
  ].join("\n");
}
