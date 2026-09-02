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

export async function readAiInbox(): Promise<InboxSignal[]> {
  try {
    const raw = await readFile(INBOX_PATH, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as InboxSignal);
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
