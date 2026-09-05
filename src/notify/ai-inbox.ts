import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { isDenylisted } from "../review/denylist.js";
import { dbPath, getDb, transaction } from "../lib/db.js";

import type { SignalEvaluation } from "../signals/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Legacy jsonl locations — import source only (pre-SQLite); overridable for tests. */
function inboxJsonlPath(): string {
  return process.env.AI_INBOX_JSONL ?? path.resolve(__dirname, "../../data/ai-inbox.jsonl");
}
function processedJsonlPath(): string {
  return (
    process.env.AI_INBOX_PROCESSED_JSONL ??
    path.resolve(__dirname, "../../data/ai-inbox-processed.jsonl")
  );
}

/**
 * AI decision inbox: every delivered trade signal is appended here; a waking
 * decider reads the unarchived rows, decides buy/size/skip, then archives them.
 * Backed by SQLite (archived flag replaces the move to ai-inbox-processed.jsonl);
 * the legacy jsonl files are imported once on first use.
 */

export interface InboxSignal {
  at: string;
  chain: string;
  address: string;
  symbol?: string;
  priceUsd?: number;
  liquidityUsd: number;
  volume24hUsd: number;
  score: number;
  triggers: string[];
  reasons: string[];
  poolId?: string;
}

/** BlockBeats 快讯叫醒条目 — AI 会话读到后自行判断是否查价/开仓/退出。 */
export interface InboxNews {
  kind: "news";
  at: string;
  title: string;
  url: string;
  reasons: string[];
  /** true = 危险信号（关注币暴跌/rug/造假）→ 优先考虑退出而非进场 */
  negative: boolean;
  note?: string;
  /** 主体币名（有则可 note 回它的 news-radar 研究 thread）。 */
  symbol?: string;
  /** true = 值得做但没解析出合约 → decider 需先深挖找 CA 再判断。 */
  needsResearch?: boolean;
}

/**
 * 永续数据异动信号(如 OI 异动)。方向已定,decider 复核后经 `npm run hl` 下单。
 * 与链上现货信号不同:标的是**永续 symbol**,无 chain/address。
 */
export interface InboxPerpSignal {
  kind: "perp-signal";
  at: string;
  /** 信号源,如 "oi-anomaly"。 */
  source: string;
  /** 基础币名(如 AKE),直接喂 `npm run hl -- long <symbol>`。 */
  symbol: string;
  side: "long" | "short";
  score: number;
  /** 触发指标快照(OI值/涨幅/大户占比/价格 等)。 */
  metrics: Record<string, number>;
  reasons: string[];
}

type InboxEntry = InboxSignal | InboxNews | InboxPerpSignal;

function kindOf(entry: InboxEntry): string {
  return (entry as { kind?: string }).kind ?? "signal";
}

const backfilledPaths = new Set<string>();
/**
 * One-time import of the pre-SQLite jsonl files: ai-inbox.jsonl → active,
 * ai-inbox-processed.jsonl → archived. Guarded by an empty-table check inside
 * the caller's transaction so a concurrent monitor + CLI can't double-import.
 */
function ensureBackfill(db: DatabaseSync): void {
  const p = dbPath();
  if (backfilledPaths.has(p)) return;
  backfilledPaths.add(p);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM inbox").get() as { n: number }).n;
  if (count > 0) return;
  const insert = db.prepare("INSERT INTO inbox (at, kind, archived, data) VALUES (?,?,?,?)");
  const importFile = (file: string, archived: number) => {
    if (!existsSync(file)) return;
    try {
      for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
        try {
          const entry = JSON.parse(line) as InboxEntry;
          insert.run(entry.at ?? new Date().toISOString(), kindOf(entry), archived, line);
        } catch {
          // skip a corrupt line
        }
      }
    } catch (err) {
      console.error("inbox backfill read failed:", (err as Error).message);
    }
  };
  importFile(inboxJsonlPath(), 0);
  importFile(processedJsonlPath(), 1);
}

/** Run the one-time backfill once, in a serialized write transaction, so reads
 *  below can be plain lock-free SELECTs (WAL). */
async function ensureBackfilled(): Promise<void> {
  if (backfilledPaths.has(dbPath())) return;
  await transaction((db) => ensureBackfill(db));
}

async function insertEntry(entry: InboxEntry): Promise<void> {
  await ensureBackfilled();
  await transaction((db) => {
    db.prepare("INSERT INTO inbox (at, kind, archived, data) VALUES (?,?,0,?)").run(
      entry.at,
      kindOf(entry),
      JSON.stringify(entry),
    );
  });
}

export async function appendAiInbox(ev: SignalEvaluation): Promise<void> {
  // A denylisted token must never wake the decider (defense in depth — the
  // scanner also filters, but news/other producers reuse these writers).
  if (await isDenylisted(ev.input.chain ?? "robinhood", ev.input.address)) return;
  const entry: InboxSignal = {
    at: new Date().toISOString(),
    chain: ev.input.chain ?? "robinhood",
    address: ev.input.address,
    symbol: ev.input.symbol,
    priceUsd: ev.input.priceUsd,
    liquidityUsd: ev.input.liquidityUsd,
    volume24hUsd: ev.input.volume24hUsd,
    score: ev.score,
    triggers: ev.triggers,
    reasons: ev.reasons,
    poolId: ev.input.primaryPairAddress,
  };
  await insertEntry(entry);
}

export async function appendAiInboxNews(
  entry: Omit<InboxNews, "kind" | "at">,
): Promise<void> {
  const line: InboxNews = { kind: "news", at: new Date().toISOString(), ...entry };
  await insertEntry(line);
}

/**
 * Smart-money trade signal → the AI inbox as a COIN signal (not news), so the
 * decider's per-token path runs (live price check → buy/skip), rather than the
 * news path which skips generic positive items. Liquidity/volume are left 0 —
 * the decider fetches live DexScreener data itself.
 */
export async function appendAiInboxSmartMoney(entry: {
  chain: string;
  address: string;
  symbol?: string;
  reasons: string[];
  distinct: number;
  usd?: number;
  poolId?: string;
}): Promise<void> {
  if (await isDenylisted(entry.chain, entry.address)) return;
  const line: InboxSignal = {
    at: new Date().toISOString(),
    chain: entry.chain,
    address: entry.address,
    symbol: entry.symbol,
    liquidityUsd: 0,
    volume24hUsd: 0,
    score: 50 + entry.distinct * 10,
    triggers: ["smart_money"],
    reasons: entry.reasons,
    poolId: entry.poolId,
  };
  await insertEntry(line);
}

export async function appendAiInboxPerp(
  entry: Omit<InboxPerpSignal, "kind" | "at">,
): Promise<void> {
  const line: InboxPerpSignal = {
    kind: "perp-signal",
    at: new Date().toISOString(),
    ...entry,
  };
  await insertEntry(line);
}

export async function readAiInbox(): Promise<InboxEntry[]> {
  try {
    await ensureBackfilled();
    const rows = getDb()
      .prepare("SELECT data FROM inbox WHERE archived=0 ORDER BY at")
      .all() as unknown as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as InboxEntry);
  } catch {
    return [];
  }
}

/**
 * address(lowercased) → earliest-seen alert priceUsd, across ALL inbox rows
 * (active + archived). Used by the self-trade review to price past alerts —
 * replaces its old direct scan of ai-inbox{,-processed}.jsonl.
 */
export async function alertPricesByToken(): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  try {
    await ensureBackfilled();
    const rows = getDb()
      .prepare("SELECT data FROM inbox ORDER BY at")
      .all() as unknown as { data: string }[];
    for (const r of rows) {
      try {
        const it = JSON.parse(r.data) as { address?: string; priceUsd?: number };
        if (!it.address || !it.priceUsd || it.priceUsd <= 0) continue;
        const key = it.address.toLowerCase();
        if (!prices.has(key)) prices.set(key, it.priceUsd);
      } catch {
        // skip unparseable row
      }
    }
    return prices;
  } catch {
    return prices;
  }
}

/** Default: a claim older than this (a dead worker) is reclaimable. */
const CLAIM_STALE_MS = 10 * 60_000;

/**
 * Concurrent deciders: atomically claim the currently-unclaimed (or stale-
 * claimed) active items for `worker`, so N deciders process DISJOINT batches in
 * parallel. Serialized by the write transaction — a second worker running at
 * the same instant claims only what the first didn't. Returns this worker's
 * batch.
 */
export async function claimInbox(worker: string, staleMs = CLAIM_STALE_MS): Promise<InboxEntry[]> {
  try {
    return await transaction((db) => {
      ensureBackfill(db);
      const cutoff = new Date(Date.now() - staleMs).toISOString();
      db.prepare(
        `UPDATE inbox SET claimed_by=?, claimed_at=?
         WHERE archived=0 AND (claimed_by IS NULL OR claimed_at < ?)`,
      ).run(worker, new Date().toISOString(), cutoff);
      const rows = db
        .prepare("SELECT data FROM inbox WHERE archived=0 AND claimed_by=? ORDER BY at")
        .all(worker) as unknown as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as InboxEntry);
    });
  } catch {
    return [];
  }
}

/** True if there is any unclaimed (or stale-claimed) active item — a new
 *  decider is only worth spawning when there is fresh work to claim. */
export async function hasClaimableInbox(staleMs = CLAIM_STALE_MS): Promise<boolean> {
  try {
    await ensureBackfilled();
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const row = getDb()
      .prepare(
        "SELECT 1 FROM inbox WHERE archived=0 AND (claimed_by IS NULL OR claimed_at < ?) LIMIT 1",
      )
      .get(cutoff);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Archive processed signals so the wake-probe stops firing. With `worker`, only
 * that worker's claimed items (so concurrent deciders don't archive each
 * other's in-flight batches); without, archive all active (legacy/single).
 */
export async function archiveAiInbox(worker?: string): Promise<void> {
  await ensureBackfilled();
  await transaction((db) => {
    if (worker) {
      db.prepare("UPDATE inbox SET archived=1 WHERE archived=0 AND claimed_by=?").run(worker);
    } else {
      db.prepare("UPDATE inbox SET archived=1 WHERE archived=0").run();
    }
  });
}
