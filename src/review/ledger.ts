import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { dbPath, getDb, transaction } from "../lib/db.js";
import { fetchPoolOhlcv, type OhlcvCandle } from "../dex/dexpaprika.js";
import { fetchDexJson } from "../dex/dexscreener.js";
import { TRUSTED_QUOTE } from "../chains/generic-analysis.js";
import { sleep } from "../lib/utils.js";
import type { AlertLevel, SignalEvaluation } from "../signals/types.js";
import { LEVEL_RANK } from "../signals/types.js";
import type { DexPair, TokenAnalysis } from "../types.js";

/**
 * True when the alert's pool is quoted against a JUNK token (not a trusted
 * asset). Such an alert recorded a FAKE price (memestock/GMEB: alertPx $1.15
 * vs real $0.0077), so grading it manufactures a fake win — void it instead.
 * Conservative: fetch failure / missing quote → not junk (still grade).
 */
export async function isJunkQuoteAlert(record: AlertRecord): Promise<boolean> {
  if (!record.poolId) return false;
  try {
    const pair = await fetchDexJson<{ pairs?: DexPair[] }>(
      `/latest/dex/pairs/${record.chain}/${record.poolId}`,
    );
    const q = (pair.pairs?.[0]?.quoteToken?.symbol ?? "").toUpperCase();
    return q.length > 0 && !TRUSTED_QUOTE.has(q);
  } catch {
    return false;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTCOMES_DIR = path.resolve(__dirname, "../../data/outcomes");
/** Legacy JSON import sources (pre-SQLite); overridable for tests. */
function legacyPendingPath(): string {
  return process.env.OUTCOMES_PENDING_PATH ?? path.join(OUTCOMES_DIR, "pending.json");
}
function legacyLabeledPath(): string {
  return process.env.OUTCOMES_LABELED_PATH ?? path.join(OUTCOMES_DIR, "labeled.json");
}

/** Peak return that graduates an alert to a win. */
export const WIN_RETURN = 0.4;
/** Drawdown (without a prior win) that grades a loss / false alert. */
export const LOSS_RETURN = -0.3;
/** Grade alerts once they are at least this old. */
export const GRADE_AFTER_MS = 24 * 60 * 60 * 1000;
/** A post-alert "return" above this is broken-candle garbage, not a real pump
 *  (mirrors MOVER_MAX_CHANGE_PCT). Such records never grade as a win — e.g.
 *  SPACEHOOD "+1252226%" from a dirty OHLCV spike. */
export const MAX_SANE_RETURN = 100; // +10000%
/** Token symbols above this length are spam (one token carried a 28KB symbol
 *  that was the entire stock ticker list) — truncate on record. */
const MAX_SYMBOL_LEN = 40;

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

const backfilledPaths = new Set<string>();
function backfillInTx(db: DatabaseSync): void {
  const p = dbPath();
  if (backfilledPaths.has(p)) return;
  backfilledPaths.add(p);
  const importArr = (
    file: string,
    table: "outcomes_pending" | "outcomes_labeled",
  ) => {
    if (!existsSync(file)) return;
    const has = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    if (has > 0) return;
    try {
      const arr = JSON.parse(readFileSync(file, "utf8")) as AlertRecord[] | LabeledOutcome[];
      for (const r of arr) {
        if (table === "outcomes_pending") insertPending(db, r as AlertRecord);
        else insertLabeled(db, r as LabeledOutcome);
      }
    } catch (err) {
      console.error(`${table} backfill failed:`, (err as Error).message);
    }
  };
  importArr(legacyPendingPath(), "outcomes_pending");
  importArr(legacyLabeledPath(), "outcomes_labeled");
}
async function ensureBackfilled(): Promise<void> {
  if (backfilledPaths.has(dbPath())) return;
  await transaction((db) => backfillInTx(db));
}

function insertPending(db: DatabaseSync, r: AlertRecord): void {
  db.prepare(
    `INSERT OR REPLACE INTO outcomes_pending (id, chain, address, at, data) VALUES (?,?,?,?,?)`,
  ).run(r.id, r.chain, r.address.toLowerCase(), r.at, JSON.stringify(r));
}
function insertLabeled(db: DatabaseSync, r: LabeledOutcome): void {
  db.prepare(
    `INSERT OR REPLACE INTO outcomes_labeled (id, chain, address, at, graded_at, data) VALUES (?,?,?,?,?,?)`,
  ).run(r.id, r.chain, r.address.toLowerCase(), r.at, r.gradedAt, JSON.stringify(r));
}

export async function loadPendingOutcomes(): Promise<AlertRecord[]> {
  try {
    await ensureBackfilled();
    return (getDb().prepare("SELECT data FROM outcomes_pending ORDER BY at").all() as unknown as {
      data: string;
    }[]).map((x) => JSON.parse(x.data) as AlertRecord);
  } catch {
    return [];
  }
}

export async function loadLabeledOutcomes(): Promise<LabeledOutcome[]> {
  try {
    await ensureBackfilled();
    return (getDb().prepare("SELECT data FROM outcomes_labeled ORDER BY at").all() as unknown as {
      data: string;
    }[]).map((x) => JSON.parse(x.data) as LabeledOutcome);
  } catch {
    return [];
  }
}

/**
 * Record an alert-level evaluation for later grading. One record per token
 * per 24h — repeated alerts on the same move grade once. The dedup + insert run
 * in one write transaction, closing the old unlocked load→push→save race
 * (recordAlertOutcome fires un-awaited from the scan loop).
 */
export async function recordAlertOutcome(
  analysis: TokenAnalysis,
  evaluation: SignalEvaluation,
): Promise<void> {
  if (LEVEL_RANK[evaluation.level] < LEVEL_RANK.alert) return;
  const chain = analysis.chain ?? "robinhood";
  const addr = analysis.address.toLowerCase();
  const now = Date.now();
  const cutoff = new Date(now - GRADE_AFTER_MS).toISOString();
  await ensureBackfilled();
  await transaction((db) => {
    const dupPending = db
      .prepare("SELECT 1 FROM outcomes_pending WHERE chain=? AND address=? AND at>=? LIMIT 1")
      .get(chain, addr, cutoff);
    const dupLabeled = db
      .prepare("SELECT 1 FROM outcomes_labeled WHERE chain=? AND address=? AND at>=? LIMIT 1")
      .get(chain, addr, cutoff);
    if (dupPending || dupLabeled) return;
    const record: AlertRecord = {
      id: `${chain}:${addr}:${new Date(now).toISOString().slice(0, 13)}`,
      chain,
      address: analysis.address,
      symbol: analysis.symbol?.slice(0, MAX_SYMBOL_LEN),
      at: new Date(now).toISOString(),
      level: evaluation.level,
      score: evaluation.score,
      triggers: evaluation.triggers,
      priceUsd: analysis.priceUsd,
      volume24hUsd: analysis.volume24hUsd ?? 0,
      liquidityUsd: analysis.liquidityUsd ?? 0,
      poolId: analysis.primaryPairAddress,
    };
    insertPending(db, record);
  });
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
  // Grade on CLOSES, not wicks: a single-candle high spike (dirty OHLCV, or a
  // 1-block wick you couldn't have sold into) must not manufacture a WIN. 牛妈
  // showed a ~$127 wick on a $5.56 alert = fake +2186% while it actually closed
  // down 97%. A real pump-and-fade still closes above +40% at some bar.
  const maxClose = Math.max(...after.map((c) => c.close));
  const minClose = Math.min(...after.map((c) => c.close));
  const maxReturn = maxClose / price - 1;
  const minReturn = minClose / price - 1;
  // Dirty-OHLCV guard: an absurd move is still broken data — grade flat, out of
  // win/loss stats.
  if (maxReturn > MAX_SANE_RETURN) {
    return { outcome: "flat", maxReturn, minReturn, candleCount: after.length };
  }
  const outcome: Outcome =
    maxReturn >= WIN_RETURN ? "win" : minReturn <= LOSS_RETURN ? "loss" : "flat";
  return { outcome, maxReturn, minReturn, candleCount: after.length };
}

/** Grade all pending records older than GRADE_AFTER_MS. Returns new labels. */
export async function gradePendingOutcomes(
  options: { drop?: (r: AlertRecord) => boolean } = {},
): Promise<LabeledOutcome[]> {
  const pending = await loadPendingOutcomes();
  const now = Date.now();
  const due = pending.filter((r) => now - new Date(r.at).getTime() >= GRADE_AFTER_MS);
  if (!due.length) return [];

  const labeled = await loadLabeledOutcomes();
  const labeledIds = new Set(labeled.map((l) => l.id));
  const graded: LabeledOutcome[] = [];

  for (const record of due) {
    // Skip caller-excluded records (stocks / malformed) and anything already
    // labeled — prevents the duplicate rows we saw in labeled.json.
    if (options.drop?.(record) || labeledIds.has(record.id)) continue;
    // Pace the per-record DexScreener/DexPaprika calls so a burst of due records
    // doesn't rate-limit the junk-quote check into a fail-open (grading fakes).
    await sleep(200);
    // Void alerts recorded on a junk-quote pool: their alertPx is fake, so
    // grading would manufacture a fake win (memestock/GMEB → +1843%).
    if (await isJunkQuoteAlert(record)) continue;
    labeledIds.add(record.id);
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

  // Commit labels + clear ALL due records from pending (graded, dropped, or
  // dup-skipped) in one transaction.
  await transaction((db) => {
    for (const g of graded) insertLabeled(db, g);
    const del = db.prepare("DELETE FROM outcomes_pending WHERE id=?");
    for (const r of due) del.run(r.id);
  });
  return graded;
}
