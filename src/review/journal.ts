import { appendJournal } from "./journal-store.js";

/**
 * Append-only journal of every review-loop run: what movers were found, what
 * the human confirmed/excluded, what the tuner changed, what backtests gated
 * it. The institutional memory of the loop — now in SQLite (journal table),
 * not a git-tracked REVIEW-LOG.md.
 */
export async function appendReviewJournal(section: string): Promise<void> {
  appendJournal("review", section.trimEnd());
}

export function journalHeader(title: string): string {
  return `## ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC — ${title}`;
}
