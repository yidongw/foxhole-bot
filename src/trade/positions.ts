import { mkdir, readFile, writeFile } from "node:fs/promises";
import { writeJsonAtomic } from "../lib/atomic-json.js";
import { withFileLock } from "../lib/file-lock.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { TradeMode, TakeProfitTier } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSITIONS_PATH = path.resolve(__dirname, "../../data/positions.json");

export interface PositionExit {
  at: string;
  priceUsd: number;
  /** Fraction of the ORIGINAL amount sold in this exit. */
  fraction: number;
  proceedsUsd: number;
  reason: string;
  txHash?: string;
}

/**
 * Per-position exit plan. Every field is an OPTIONAL override of the global
 * TradeConfig default for THIS position — a smart-money early launch, a pure
 * momentum chase and a news-driven hold each deserve different rails, so the
 * AI sets the plan at buy time and can re-tune it as the position develops
 * (a runner that has clearly de-risked can widen its trail; a thesis that
 * broke can tighten its stop). Anything left undefined falls back to config.
 */
export interface PositionStrategy {
  /** Exit-everything stop, fraction below entry (e.g. 0.35 = -35%). */
  hardStopPct?: number;
  /** Trail: give-back off the high-water mark that closes the rest. */
  trailStopPct?: number;
  /** Trail arms only once high-water ≥ entry × this multiple. */
  trailArmMultiple?: number;
  /** Tiered take-profit ladder (multiple of entry → fraction to sell). */
  takeProfits?: TakeProfitTier[];
  /** Force-close after this many hours regardless of P&L. */
  maxHoldHours?: number;
  /** Free-text thesis / plan so the next AI pass reasons against intent. */
  note?: string;
  /** Last time the plan was set or adjusted. */
  updatedAt?: string;
}

export interface Position {
  id: string;
  mode: TradeMode;
  /** Chain id; absent = robinhood (legacy). */
  chain?: string;
  token: string;
  symbol?: string;
  trigger: string;
  openedAt: string;
  entryPriceUsd: number;
  /** FDV/市值 at entry (USD); lets the dashboard show MC, and derive live MC
   *  as entryFdvUsd × currentPrice/entryPrice (supply ~constant). */
  entryFdvUsd?: number;
  /** Token amount bought (human units). */
  amountTokens: number;
  costUsd: number;
  highWaterUsd: number;
  exits: PositionExit[];
  status: "open" | "closed";
  closedAt?: string;
  txHash?: string;
  /** Last LLM advisor consultation (throttling). */
  lastAdvisorAt?: string;
  /** Per-position exit plan; overrides global config where set. */
  strategy?: PositionStrategy;
}

export interface PositionsFile {
  version: 1;
  /** Last daily P&L report timestamp. */
  lastReportAt?: string;
  positions: Position[];
}

export async function loadPositions(): Promise<PositionsFile> {
  try {
    const raw = await readFile(POSITIONS_PATH, "utf8");
    return JSON.parse(raw) as PositionsFile;
  } catch {
    return { version: 1, positions: [] };
  }
}

export async function savePositions(file: PositionsFile): Promise<void> {
  await writeJsonAtomic(POSITIONS_PATH, file);
}

/**
 * The ONLY safe way to write the ledger from concurrent processes: take the
 * cross-process lock, load FRESH state, apply the mutation, save, release.
 * Do all slow work (price fetches, chain calls) BEFORE calling this — the
 * mutator must be fast. Direct load→mutate→save with a stale snapshot is what
 * ate a buy, resurrected a sold honeypot and rolled back the denylist on
 * 2026-09-04.
 */
export async function mutatePositions<T>(
  mutator: (file: PositionsFile) => T | Promise<T>,
): Promise<{ file: PositionsFile; result: T }> {
  return withFileLock(POSITIONS_PATH + ".lock", async () => {
    const file = await loadPositions();
    const result = await mutator(file);
    await savePositions(file);
    return { file, result };
  });
}

export function openPositions(file: PositionsFile): Position[] {
  return file.positions.filter((p) => p.status === "open");
}

export function findOpen(file: PositionsFile, token: string): Position | undefined {
  return file.positions.find(
    (p) => p.status === "open" && p.token.toLowerCase() === token.toLowerCase(),
  );
}

/**
 * Capital still at risk from entries since the given time (24h cap basis).
 * Realized proceeds are netted out per position: recycling returned money
 * can't raise the worst case (if every position rugs, proceeds are 0 and
 * the cap binds on gross anyway), but gross counting starved the learning
 * loop — 4 closed round-trips "spent" $200 while true exposure was ~$50,
 * blocking every later entry for a full day (LIGMA, BONER 2026-09-03).
 */
export function spendSince(file: PositionsFile, sinceIso: string): number {
  return file.positions
    .filter((p) => p.openedAt >= sinceIso)
    .reduce((sum, p) => sum + Math.max(0, p.costUsd - realizedUsd(p)), 0);
}

/**
 * Free cash in the paper account: starting capital minus what every entry
 * cost, plus everything exits have returned. Open positions hold the rest
 * as tokens (their market value is added back for equity).
 *
 * Only `mode: "paper"` positions count — live positions are settled by the
 * real on-chain wallet balance, not this notional paper ledger, so mixing
 * them in (once a chain runs live) would corrupt paper cash accounting.
 */
export function paperCashUsd(
  file: PositionsFile,
  startUsd: number,
  chain?: string,
): number {
  let cash = startUsd;
  for (const p of file.positions) {
    if (p.mode !== "paper") continue;
    if (chain && (p.chain ?? "robinhood") !== chain) continue;
    cash -= p.costUsd;
    cash += realizedUsd(p);
  }
  return cash;
}

/**
 * Merge an exit computed against a SNAPSHOT into the FRESH position under the
 * ledger lock. If another writer already sold part (or all) of the position in
 * between, clamp the fraction to what actually remains and scale proceeds
 * proportionally; a fully-exited position absorbs nothing. Returns the exit
 * as applied, or undefined when nothing remained.
 */
export function mergeExitIntoFresh(
  fp: Position,
  exit: PositionExit,
): PositionExit | undefined {
  const remaining = remainingFraction(fp);
  if (remaining <= 1e-9 || exit.fraction <= 0) return undefined;
  const f = Math.min(exit.fraction, remaining);
  const scaled =
    f === exit.fraction
      ? exit
      : { ...exit, fraction: f, proceedsUsd: exit.proceedsUsd * (f / exit.fraction) };
  recordExit(fp, scaled);
  return scaled;
}

export function remainingFraction(p: Position): number {
  return Math.max(0, 1 - p.exits.reduce((s, e) => s + e.fraction, 0));
}

export function realizedUsd(p: Position): number {
  return p.exits.reduce((s, e) => s + e.proceedsUsd, 0);
}

/** Realized + mark-to-market P&L vs cost. */
export function totalPnlUsd(p: Position, currentPriceUsd?: number): number {
  const unrealized =
    p.status === "open" && currentPriceUsd != null
      ? remainingFraction(p) * p.amountTokens * currentPriceUsd
      : 0;
  return realizedUsd(p) + unrealized - p.costUsd;
}

/**
 * Clamp a strategy patch to sane ranges before it touches a position. The AI
 * (or a manual command) supplies these, so guard against fat-finger values
 * that would disable a rail: stops must stay in (0,0.95], the trail arm ≥1,
 * TP multiples >1 with fractions in (0,1], hold hours positive. Undefined
 * fields are left untouched (they fall back to config).
 */
export function sanitizeStrategy(patch: PositionStrategy): PositionStrategy {
  const out: PositionStrategy = {};
  const pct = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= 0.95 ? n : undefined;
  };
  if (patch.hardStopPct !== undefined) out.hardStopPct = pct(patch.hardStopPct);
  if (patch.trailStopPct !== undefined) out.trailStopPct = pct(patch.trailStopPct);
  if (patch.trailArmMultiple !== undefined) {
    const n = Number(patch.trailArmMultiple);
    if (Number.isFinite(n) && n >= 1) out.trailArmMultiple = n;
  }
  if (patch.maxHoldHours !== undefined) {
    const n = Number(patch.maxHoldHours);
    if (Number.isFinite(n) && n > 0) out.maxHoldHours = n;
  }
  if (patch.takeProfits !== undefined) {
    const tiers = (patch.takeProfits ?? [])
      .map((t) => ({ atMultiple: Number(t.atMultiple), sellFraction: Number(t.sellFraction) }))
      .filter(
        (t) =>
          Number.isFinite(t.atMultiple) &&
          t.atMultiple > 1 &&
          Number.isFinite(t.sellFraction) &&
          t.sellFraction > 0 &&
          t.sellFraction <= 1,
      )
      .sort((a, b) => a.atMultiple - b.atMultiple);
    out.takeProfits = tiers;
  }
  if (patch.note !== undefined) out.note = String(patch.note).slice(0, 300);
  // Drop keys that sanitized to undefined so they don't shadow config as junk.
  for (const k of Object.keys(out) as (keyof PositionStrategy)[]) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

/** Apply a sanitized patch onto a position's existing strategy (field-wise). */
export function mergeStrategy(p: Position, patch: PositionStrategy): void {
  const clean = sanitizeStrategy(patch);
  const next: PositionStrategy = { ...(p.strategy ?? {}), ...clean };
  next.updatedAt = new Date().toISOString();
  p.strategy = next;
}

/** One-line human summary of the rails a position is running (for reports). */
export function formatStrategy(s: PositionStrategy | undefined): string {
  if (!s) return "默认策略";
  const parts: string[] = [];
  if (s.hardStopPct !== undefined) parts.push(`硬止损 -${(s.hardStopPct * 100).toFixed(0)}%`);
  if (s.trailStopPct !== undefined || s.trailArmMultiple !== undefined) {
    const arm = s.trailArmMultiple !== undefined ? `${s.trailArmMultiple}x起` : "";
    const give = s.trailStopPct !== undefined ? `-${(s.trailStopPct * 100).toFixed(0)}%回撤` : "";
    parts.push(`移动止损 ${[arm, give].filter(Boolean).join(" ")}`.trim());
  }
  if (s.takeProfits?.length) {
    parts.push(
      "止盈 " +
        s.takeProfits.map((t) => `${t.atMultiple}x→${(t.sellFraction * 100).toFixed(0)}%`).join("/"),
    );
  }
  if (s.maxHoldHours !== undefined) parts.push(`最长持有 ${s.maxHoldHours}h`);
  if (s.note) parts.push(`「${s.note}」`);
  return parts.length ? parts.join(", ") : "默认策略";
}

export function recordExit(p: Position, exit: PositionExit): void {
  p.exits.push(exit);
  if (remainingFraction(p) <= 1e-9) {
    p.status = "closed";
    p.closedAt = exit.at;
  }
}
