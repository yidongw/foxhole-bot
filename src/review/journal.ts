import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const JOURNAL_PATH = path.resolve(__dirname, "../../REVIEW-LOG.md");

/**
 * Append-only markdown journal of every review-loop run: what movers were
 * found, what the human confirmed/excluded, what the tuner changed, what
 * backtests gated it. The repo's institutional memory of the loop.
 */
export async function appendReviewJournal(section: string): Promise<void> {
  await mkdir(path.dirname(JOURNAL_PATH), { recursive: true });
  await appendFile(JOURNAL_PATH, section.trimEnd() + "\n\n", "utf8");
}

export function journalHeader(title: string): string {
  return `## ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC — ${title}`;
}
