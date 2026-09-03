import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.resolve(__dirname, "../../data/smart-money-log.jsonl");

/**
 * Append-only record of smart-money events so the 3h review has real numbers
 * (alerts fired, AI escalations, per token/wallet). One JSON object per line.
 */
export interface SmLogEntry {
  at: string;
  kind: "alert" | "trigger" | "skipped";
  chain: string;
  wallet: string;
  walletLabel?: string;
  token: string;
  symbol?: string;
  usd?: number;
  txHash?: string;
  /** distinct tracked wallets in-window at the time (for triggers/alerts). */
  distinct?: number;
  reason?: string;
}

export async function appendSmLog(entry: Omit<SmLogEntry, "at">): Promise<void> {
  const line: SmLogEntry = { at: new Date().toISOString(), ...entry };
  await mkdir(path.dirname(LOG_PATH), { recursive: true });
  await appendFile(LOG_PATH, JSON.stringify(line) + "\n", "utf8");
}

export async function readSmLog(sinceMs?: number): Promise<SmLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(LOG_PATH, "utf8");
  } catch {
    return [];
  }
  const rows = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SmLogEntry);
  if (sinceMs === undefined) return rows;
  return rows.filter((r) => new Date(r.at).getTime() >= sinceMs);
}
