import { mkdir, readFile, writeFile } from "node:fs/promises";
import { writeJsonAtomic } from "../lib/atomic-json.js";
import { withFileLock } from "../lib/file-lock.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DENYLIST_PATH = path.resolve(__dirname, "../../data/review-denylist.json");

/**
 * Human-judgment denylist: tokens the user marked as garbage during review
 * confirmation. Permanent — filtered from mover lists, tuner cases, and
 * vetoed at the entry gate. This is how manual review feedback compounds.
 */

export interface DenyEntry {
  chain: string;
  address: string;
  symbol?: string;
  reason: string;
  addedAt: string;
}

export async function loadDenylist(): Promise<DenyEntry[]> {
  try {
    return JSON.parse(await readFile(DENYLIST_PATH, "utf8")) as DenyEntry[];
  } catch {
    return [];
  }
}

export async function addToDenylist(entries: Omit<DenyEntry, "addedAt">[]): Promise<void> {
  // Under the cross-process lock with a FRESH read — concurrent review loops
  // doing load→edit→save rolled back each other's entries on 2026-09-04
  // (pussy/BEARER honeypot entries vanished within the hour).
  await withFileLock(DENYLIST_PATH + ".lock", async () => {
  const existing = await loadDenylist();
  const seen = new Set(existing.map((e) => `${e.chain}:${e.address.toLowerCase()}`));
  for (const e of entries) {
    const key = `${e.chain}:${e.address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    existing.push({ ...e, addedAt: new Date().toISOString() });
  }
  await writeJsonAtomic(DENYLIST_PATH, existing);
  });
}

export async function isDenylisted(chain: string, address: string): Promise<boolean> {
  const list = await loadDenylist();
  const key = `${chain}:${address.toLowerCase()}`;
  return list.some((e) => `${e.chain}:${e.address.toLowerCase()}` === key);
}
