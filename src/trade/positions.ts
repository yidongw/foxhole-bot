import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { dbPath, getDb, transaction } from "../lib/db.js";

import type { TradeMode, TakeProfitTier } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Legacy JSON ledger — import source only; overridable for tests. */
function legacyPositionsPath(): string {
  return (
    process.env.POSITIONS_FILE_PATH ??
    path.resolve(__dirname, "../../data/positions.json")
  );
}

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

const backfilledPaths = new Set<string>();
/**
 * One-time import of the pre-SQLite data/positions.json. Guarded by an empty-
 * table check inside the write transaction so a concurrent monitor + CLI can't
 * double-import (SQLite serializes the writers; the second sees a non-empty
 * table). Called inside every DB access below.
 */
function ensureBackfill(db: DatabaseSync): void {
  const p = dbPath();
  if (backfilledPaths.has(p)) return;
  backfilledPaths.add(p);
  const jsonl = legacyPositionsPath();
  if (!existsSync(jsonl)) return;
  const count = (db.prepare("SELECT COUNT(*) AS n FROM positions").get() as { n: number }).n;
  if (count > 0) return;
  try {
    const file = JSON.parse(readFileSync(jsonl, "utf8")) as PositionsFile;
    for (const pos of file.positions ?? []) upsertPosition(db, pos);
    if (file.lastReportAt) setMeta(db, "lastReportAt", file.lastReportAt);
  } catch (err) {
    console.error("positions backfill failed:", (err as Error).message);
  }
}

/** Run the one-time backfill once, in a serialized write transaction, so reads
 *  below can be plain lock-free SELECTs (WAL) with no SQLITE_BUSY risk. */
async function ensureBackfilled(): Promise<void> {
  if (backfilledPaths.has(dbPath())) return;
  await transaction((db) => ensureBackfill(db));
}

function upsertPosition(db: DatabaseSync, p: Position): void {
  db.prepare(
    `INSERT INTO positions (id, status, chain, token, mode, opened_at, cost_usd, data)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       status=excluded.status, chain=excluded.chain, token=excluded.token,
       mode=excluded.mode, opened_at=excluded.opened_at, cost_usd=excluded.cost_usd,
       data=excluded.data`,
  ).run(
    p.id,
    p.status,
    (p.chain ?? "robinhood").toLowerCase(),
    p.token.toLowerCase(),
    p.mode,
    p.openedAt,
    p.costUsd,
    JSON.stringify(p),
  );
}

function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO kv (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(key, value);
}

function readFileFrom(db: DatabaseSync): PositionsFile {
  const rows = db.prepare("SELECT data FROM positions ORDER BY opened_at").all() as unknown as {
    data: string;
  }[];
  const meta = db.prepare("SELECT value FROM kv WHERE key='lastReportAt'").get() as
    | { value: string }
    | undefined;
  const file: PositionsFile = {
    version: 1,
    positions: rows.map((r) => JSON.parse(r.data) as Position),
  };
  if (meta?.value) file.lastReportAt = meta.value;
  return file;
}

export async function loadPositions(): Promise<PositionsFile> {
  try {
    await ensureBackfilled();
    return readFileFrom(getDb()); // plain lock-free read (WAL)
  } catch {
    return { version: 1, positions: [] };
  }
}

/** Persist the whole file (upsert every position) atomically. */
export async function savePositions(file: PositionsFile): Promise<void> {
  await ensureBackfilled();
  await transaction((db) => {
    for (const p of file.positions) upsertPosition(db, p);
    if (file.lastReportAt) setMeta(db, "lastReportAt", file.lastReportAt);
  });
}

/**
 * The ONLY safe way to write the ledger from concurrent processes: an IMMEDIATE
 * write transaction that loads FRESH state, applies the mutation, and persists
 * — atomically. Cross-process writers serialize on SQLite's write lock, so no
 * stale snapshot can overwrite a concurrent write (what ate a buy, resurrected
 * a sold honeypot and rolled back the denylist on 2026-09-04). Do slow work
 * (price fetches, chain calls) BEFORE calling this — the mutator must be fast,
 * it runs inside the write lock.
 */
export async function mutatePositions<T>(
  mutator: (file: PositionsFile) => T | Promise<T>,
): Promise<{ file: PositionsFile; result: T }> {
  await ensureBackfilled();
  return transaction(async (db) => {
    const file = readFileFrom(db);
    const result = await mutator(file);
    for (const p of file.positions) upsertPosition(db, p);
    if (file.lastReportAt) setMeta(db, "lastReportAt", file.lastReportAt);
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
