import { mkdir, readFile, writeFile } from "node:fs/promises";
import { writeJsonAtomic } from "../lib/atomic-json.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchPoolOhlcv, type OhlcvCandle } from "../dex/dexpaprika.js";
import type { AlertLevel, SignalEvaluation } from "../signals/types.js";
import { LEVEL_RANK } from "../signals/types.js";
import type { TokenAnalysis } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTCOMES_DIR = path.resolve(__dirname, "../../data/outcomes");
const PENDING_PATH = path.join(OUTCOMES_DIR, "pending.json");
const LABELED_PATH = path.join(OUTCOMES_DIR, "labeled.json");

/** Peak return that graduates an alert to a win. */
export const WIN_RETURN = 0.4;
/** Drawdown (without a prior win) that grades a loss / false alert. */
export const LOSS_RETURN = -0.3;
/** Grade alerts once they are at least this old. */
export const GRADE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface AlertRecord {
  id: string;
  chain: string;
  address: string;
  symbol?: string;
  at: string;
  level: AlertLevel;
  score: number;
  triggers: string[];
  priceUsd?: number;
  volume24hUsd: number;
  liquidityUsd: number;
  /** DexPaprika-compatible pool id (DexScreener pairAddress). */
  poolId?: string;
}

export type Outcome = "win" | "flat" | "loss";

export interface LabeledOutcome extends AlertRecord {
  outcome: Outcome;
  /** Peak return after the alert (0.4 = +40%). */
  maxReturn?: number;
  minReturn?: number;
  gradedAt: string;
  candleCount: number;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeJsonAtomic(file, value);
}

export async function loadPendingOutcomes(): Promise<AlertRecord[]> {
  return readJson<AlertRecord[]>(PENDING_PATH, []);
}

export async function loadLabeledOutcomes(): Promise<LabeledOutcome[]> {
  return readJson<LabeledOutcome[]>(LABELED_PATH, []);
}

/**
 * Record an alert-level evaluation for later grading. One record per token
 * per 24h — repeated alerts on the same move grade once.
 */
export async function recordAlertOutcome(
  analysis: TokenAnalysis,
  evaluation: SignalEvaluation,
): Promise<void> {
  if (LEVEL_RANK[evaluation.level] < LEVEL_RANK.alert) return;
  const chain = analysis.chain ?? "robinhood";
  const key = `${chain}:${analysis.address.toLowerCase()}`;
  const now = Date.now();

  const pending = await loadPendingOutcomes();
  const recent = pending.find(
    (r) =>
      `${r.chain}:${r.address.toLowerCase()}` === key &&
      now - new Date(r.at).getTime() < GRADE_AFTER_MS,
  );
  if (recent) return;
  const labeled = await loadLabeledOutcomes();
  const recentLabeled = labeled.find(
    (r) =>
      `${r.chain}:${r.address.toLowerCase()}` === key &&
      now - new Date(r.at).getTime() < GRADE_AFTER_MS,
  );
  if (recentLabeled) return;

  pending.push({
    id: `${key}:${new Date(now).toISOString().slice(0, 13)}`,
    chain,
    address: analysis.address,
    symbol: analysis.symbol,
    at: new Date(now).toISOString(),
    level: evaluation.level,
    score: evaluation.score,
    triggers: evaluation.triggers,
    priceUsd: analysis.priceUsd,
    volume24hUsd: analysis.volume24hUsd ?? 0,
    liquidityUsd: analysis.liquidityUsd ?? 0,
    poolId: analysis.primaryPairAddress,
  });
  await writeJson(PENDING_PATH, pending);
}

/** Pure grading from post-alert candles — exported for tests. */
export function gradeFromCandles(
  record: Pick<AlertRecord, "priceUsd" | "at">,
  candles: OhlcvCandle[],
): { outcome: Outcome; maxReturn?: number; minReturn?: number; candleCount: number } {
  const alertMs = new Date(record.at).getTime();
  const after = candles.filter((c) => new Date(c.time_close).getTime() > alertMs);
  const price = record.priceUsd;
  if (!after.length || !price || price <= 0) {
    // no data 24h later usually means the pool died — that's a loss
    return { outcome: "loss", candleCount: after.length };
  }
  const maxHigh = Math.max(...after.map((c) => c.high));
  const minLow = Math.min(...after.map((c) => c.low));
  const maxReturn = maxHigh / price - 1;
  const minReturn = minLow / price - 1;
  const outcome: Outcome =
    maxReturn >= WIN_RETURN ? "win" : minReturn <= LOSS_RETURN ? "loss" : "flat";
  return { outcome, maxReturn, minReturn, candleCount: after.length };
}

/** Grade all pending records older than GRADE_AFTER_MS. Returns new labels. */
export async function gradePendingOutcomes(): Promise<LabeledOutcome[]> {
  const pending = await loadPendingOutcomes();
  const now = Date.now();
  const due = pending.filter((r) => now - new Date(r.at).getTime() >= GRADE_AFTER_MS);
  if (!due.length) return [];

  const labeled = await loadLabeledOutcomes();
  const graded: LabeledOutcome[] = [];

  for (const record of due) {
    let candles: OhlcvCandle[] = [];
    if (record.poolId) {
      try {
        candles = await fetchPoolOhlcv(record.poolId, {
          start: record.at.slice(0, 10),
          interval: "1h",
          limit: 72,
          network: record.chain,
        });
      } catch (err) {
        console.error(
          `outcome OHLCV failed ${record.symbol}:`,
          (err as Error).message,
        );
      }
    }
    const grade = gradeFromCandles(record, candles);
    graded.push({ ...record, ...grade, gradedAt: new Date().toISOString() });
  }

  labeled.push(...graded);
  await writeJson(LABELED_PATH, labeled);
  await writeJson(
    PENDING_PATH,
    pending.filter((r) => !due.includes(r)),
  );
  return graded;
}
