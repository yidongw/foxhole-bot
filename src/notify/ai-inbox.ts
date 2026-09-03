import { appendFile, mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SignalEvaluation } from "../signals/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INBOX_PATH = path.resolve(__dirname, "../../data/ai-inbox.jsonl");
const PROCESSED_PATH = path.resolve(__dirname, "../../data/ai-inbox-processed.jsonl");

/**
 * AI decision inbox: every delivered trade signal is appended here; a
 * waiting background probe wakes the Claude session, which reads the inbox,
 * decides buy/size/skip, then archives it.
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

export async function appendAiInbox(ev: SignalEvaluation): Promise<void> {
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
  await mkdir(path.dirname(INBOX_PATH), { recursive: true });
  await appendFile(INBOX_PATH, JSON.stringify(entry) + "\n", "utf8");
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

export async function appendAiInboxNews(
  entry: Omit<InboxNews, "kind" | "at">,
): Promise<void> {
  const line: InboxNews = { kind: "news", at: new Date().toISOString(), ...entry };
  await mkdir(path.dirname(INBOX_PATH), { recursive: true });
  await appendFile(INBOX_PATH, JSON.stringify(line) + "\n", "utf8");
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
  await mkdir(path.dirname(INBOX_PATH), { recursive: true });
  await appendFile(INBOX_PATH, JSON.stringify(line) + "\n", "utf8");
}

export async function readAiInbox(): Promise<Array<InboxSignal | InboxNews>> {
  try {
    const raw = await readFile(INBOX_PATH, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as InboxSignal | InboxNews);
  } catch {
    return [];
  }
}

/** Archive processed signals so the wake-probe stops firing. */
export async function archiveAiInbox(): Promise<void> {
  try {
    const raw = await readFile(INBOX_PATH, "utf8");
    if (raw) await appendFile(PROCESSED_PATH, raw, "utf8");
    const { rm } = await import("node:fs/promises");
    await rm(INBOX_PATH, { force: true });
  } catch {
    // nothing to archive
  }
}
