import { appendJournal } from "../review/journal-store.js";

/**
 * 交易日志 — every entry, exit, and vetoed entry with reasoning and numbers.
 * Best-effort; never throws. Now a row in the SQLite journal table (kind=trade)
 * instead of a git-tracked journal/trades/*.md.
 */
export async function appendTradeJournal(line: string): Promise<void> {
  try {
    const stamp = new Date().toISOString().slice(11, 19);
    appendJournal("trade", `**${stamp} UTC** ${line}`);
  } catch (err) {
    console.error("trade journal write failed:", (err as Error).message);
  }
}
