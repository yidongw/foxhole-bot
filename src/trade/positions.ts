import { mkdir, readFile, writeFile } from "node:fs/promises";
import { writeJsonAtomic } from "../lib/atomic-json.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { TradeMode } from "./config.js";

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

export function recordExit(p: Position, exit: PositionExit): void {
  p.exits.push(exit);
  if (remainingFraction(p) <= 1e-9) {
    p.status = "closed";
    p.closedAt = exit.at;
  }
}
