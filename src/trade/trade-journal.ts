import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADES_DIR = path.resolve(__dirname, "../../journal/trades");

/**
 * 交易日志 — one markdown file per day recording every entry, exit, and
 * vetoed entry with the reasoning and numbers. Best-effort; never throws.
 */
export async function appendTradeJournal(line: string): Promise<void> {
  try {
    await mkdir(TRADES_DIR, { recursive: true });
    const file = path.join(TRADES_DIR, `${new Date().toISOString().slice(0, 10)}.md`);
    const stamp = new Date().toISOString().slice(11, 19);
    await appendFile(file, `- **${stamp} UTC** ${line}\n`, "utf8");
  } catch (err) {
    console.error("trade journal write failed:", (err as Error).message);
  }
}
