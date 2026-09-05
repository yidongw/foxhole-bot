import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dbPath, getDb } from "../lib/db.js";

/**
 * Decision journal — the decider is a fresh headless `claude -p` each wake with
 * NO session memory, so its only continuity is what the file layer surfaces
 * back into its read faces (inbox / status). Before this, a `skip` was not even
 * a first-class decision: the decider just didn't buy and posted a Discord note
 * it could never read again, so the SAME token re-entering the inbox got
 * re-analysed from scratch — wasting the scarce single-decider window and
 * letting two passes reach opposite verdicts on identical data.
 *
 * Persists every buy / sell / skip with a decision-time snapshot so a later
 * pass sees "you already skipped this 25min ago: R (revisit $X)" inline on
 * inbox re-entry and fast-paths instead of redoing the work. Soft context,
 * never a hard block (denylist does hard blocks) — a prior verdict may be
 * overridden when the data genuinely changed, but the decider must say why.
 *
 * Backed by SQLite (indexed lookups by token/time instead of O(n) jsonl scans);
 * an existing data/decisions.jsonl is imported once on first use.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** How far back a prior verdict is considered relevant for inbox annotation. */
export const PRIOR_WINDOW_MS = 48 * 60 * 60_000;
/** Window for the "recently skipped, nothing changed" wake suppression. */
const REWAKE_WINDOW_MS = 2 * 60 * 60_000;
/** Price move beyond this vs the skip snapshot counts as a material change. */
const MATERIAL_PRICE_MOVE = 0.15;

export type Verdict = "buy" | "sell" | "skip";

export interface DecisionSnap {
  price?: number;
  liq?: number;
  mcap?: number;
}

export interface Decision {
  at: string;
  verdict: Verdict;
  chain: string;
  /** Coin address (lowercased) for spot; base symbol for perp/news. */
  token: string;
  symbol?: string;
  reason: string;
  /** Optional condition under which a skip is worth revisiting. */
  revisit?: string;
  snap?: DecisionSnap;
  /** Signal source / trigger for later attribution in review. */
  source?: string;
}

interface Row {
  at: string;
  verdict: string;
  chain: string;
  token: string;
  symbol: string | null;
  reason: string;
  revisit: string | null;
  snap_price: number | null;
  snap_liq: number | null;
  snap_mcap: number | null;
  source: string | null;
}

function rowToDecision(r: Row): Decision {
  const snap: DecisionSnap = {};
  if (r.snap_price != null) snap.price = r.snap_price;
  if (r.snap_liq != null) snap.liq = r.snap_liq;
  if (r.snap_mcap != null) snap.mcap = r.snap_mcap;
  const d: Decision = {
    at: r.at,
    verdict: r.verdict as Verdict,
    chain: r.chain,
    token: r.token,
    reason: r.reason,
  };
  if (r.symbol != null) d.symbol = r.symbol;
  if (r.revisit != null) d.revisit = r.revisit;
  if (r.source != null) d.source = r.source;
  if (Object.keys(snap).length) d.snap = snap;
  return d;
}

/** Legacy jsonl location (import source); overridable for tests. */
function legacyJsonlPath(): string {
  return (
    process.env.DECISIONS_LOG_PATH ??
    path.resolve(__dirname, "../../data/decisions.jsonl")
  );
}

const backfilledPaths = new Set<string>();
/**
 * One-time import of the pre-SQLite data/decisions.jsonl. Guarded by an
 * IMMEDIATE transaction + empty-table check so concurrent processes (monitor +
 * a one-shot CLI) can't double-import: SQLite serializes the writers, and the
 * second sees a non-empty table and skips. Memoised per db path.
 */
function ensureBackfill(): void {
  const p = dbPath();
  if (backfilledPaths.has(p)) return;
  backfilledPaths.add(p);
  const db = getDb();
  const jsonl = legacyJsonlPath();
  if (!existsSync(jsonl)) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const count = (db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number }).n;
    if (count === 0) {
      const raw = readFileSync(jsonl, "utf8");
      const insert = db.prepare(
        `INSERT INTO decisions (at, verdict, chain, token, symbol, reason, revisit, snap_price, snap_liq, snap_mcap, source)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const line of raw.split("\n").filter(Boolean)) {
        try {
          const d = JSON.parse(line) as Decision;
          insert.run(
            d.at,
            d.verdict,
            String(d.chain).toLowerCase(),
            String(d.token).toLowerCase(),
            d.symbol ?? null,
            d.reason,
            d.revisit ?? null,
            d.snap?.price ?? null,
            d.snap?.liq ?? null,
            d.snap?.mcap ?? null,
            d.source ?? null,
          );
        } catch {
          // skip a corrupt line rather than abort the whole import
        }
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    console.error("decisions backfill failed:", (err as Error).message);
  }
}

function db() {
  ensureBackfill();
  return getDb();
}

export async function appendDecision(d: Omit<Decision, "at">): Promise<void> {
  try {
    db()
      .prepare(
        `INSERT INTO decisions (at, verdict, chain, token, symbol, reason, revisit, snap_price, snap_liq, snap_mcap, source)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        new Date().toISOString(),
        d.verdict,
        d.chain.toLowerCase(),
        d.token.toLowerCase(),
        d.symbol ?? null,
        d.reason.slice(0, 240),
        d.revisit?.slice(0, 160) ?? null,
        d.snap?.price ?? null,
        d.snap?.liq ?? null,
        d.snap?.mcap ?? null,
        d.source ?? null,
      );
  } catch (err) {
    // A decision-log write must never break a trade or a wake.
    console.error("decision log write failed:", (err as Error).message);
  }
}

export async function readDecisions(): Promise<Decision[]> {
  try {
    const rows = db().prepare("SELECT * FROM decisions ORDER BY at").all() as unknown as Row[];
    return rows.map(rowToDecision);
  } catch {
    return [];
  }
}

/** Most recent decision for a token within `withinMs` (default 48h), if any. */
export async function priorVerdict(
  chain: string,
  token: string,
  withinMs = PRIOR_WINDOW_MS,
): Promise<Decision | undefined> {
  try {
    const cutoff = new Date(Date.now() - withinMs).toISOString();
    const row = db()
      .prepare(
        `SELECT * FROM decisions
         WHERE chain=? AND token=? AND at>=?
         ORDER BY at DESC LIMIT 1`,
      )
      .get(chain.toLowerCase(), token.toLowerCase(), cutoff) as Row | undefined;
    return row ? rowToDecision(row) : undefined;
  } catch {
    return undefined;
  }
}

/** One-line human/AI annotation of a prior verdict for inbox/status display. */
export function formatPriorVerdict(d: Decision): string {
  const ageMin = Math.max(0, Math.round((Date.now() - new Date(d.at).getTime()) / 60_000));
  const age = ageMin >= 60 ? `${Math.round(ageMin / 60)}h前` : `${ageMin}分钟前`;
  const tag = { buy: "已买", sell: "已卖", skip: "已skip" }[d.verdict];
  const revisit = d.revisit ? ` (revisit: ${d.revisit})` : "";
  return `${age}${tag}: ${d.reason}${revisit}`;
}

/**
 * Stage 3 —免疫无意义的重复唤醒. Returns true when this coin was skipped inside
 * the last 2h AND we can PROVE nothing material changed (price within ±15% of
 * the skip snapshot). We only suppress when the no-change is provable; missing
 * data → do NOT suppress (a wasted decider run is cheaper than a missed mover).
 * The signal is still appended to the inbox — suppression only skips the extra
 * `claude -p` spawn; the next genuine wake or the hourly patrol still sees it.
 */
export async function suppressRewake(
  chain: string,
  token: string,
  snap: DecisionSnap,
): Promise<boolean> {
  const prior = await priorVerdict(chain, token, REWAKE_WINDOW_MS);
  if (!prior || prior.verdict !== "skip") return false;
  const then = prior.snap?.price;
  const now = snap.price;
  if (!(then && then > 0) || !(now && now > 0)) return false; // unprovable → don't suppress
  const moved = Math.abs(now / then - 1) >= MATERIAL_PRICE_MOVE;
  return !moved; // no material move since the skip → suppress the redundant wake
}

/**
 * Compact recent-decision digest for `ai-trade status`, so even the no-new-
 * signal patrol has continuity with what recent passes decided (skips first —
 * they're the ones with no other read surface). Empty string when nothing recent.
 */
export async function formatRecentDecisions(withinMs = 12 * 60 * 60_000): Promise<string> {
  let recent: Decision[];
  try {
    const cutoff = new Date(Date.now() - withinMs).toISOString();
    const rows = db()
      .prepare("SELECT * FROM decisions WHERE at>=? ORDER BY at DESC LIMIT 15")
      .all(cutoff) as unknown as Row[];
    recent = rows.map(rowToDecision).reverse(); // back to chronological
  } catch {
    return "";
  }
  if (!recent.length) return "";
  const tag = { buy: "🟢买", sell: "🔴卖", skip: "⚪skip" } as const;
  const lines = recent.map((d) => {
    const who = d.symbol ?? d.token.slice(0, 8);
    const revisit = d.revisit ? ` ⟳${d.revisit}` : "";
    return `${tag[d.verdict]} ${who} [${d.chain}] ${d.reason.slice(0, 80)}${revisit} (${d.at.slice(5, 16)})`;
  });
  return [
    "=== 🗒️ 近期决策(含skip, 12h)===",
    ...lines,
    "参考: 同一标的再进 inbox 时会带上这条前次结论,数据没变就别推翻自己;真变了要说明改主意的理由。",
  ].join("\n");
}
