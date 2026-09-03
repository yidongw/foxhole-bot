import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "../lib/atomic-json.js";

/**
 * Local record of "good tokens" — the tokens WE consider validated (reached a
 * real peak mcap, not a rug). This is the source universe the winner-finder
 * mines for wallets worth tracking. Maintained by hand (CLI) and, later,
 * auto-appended by the review when a token's peak mcap clears the bar.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATH = path.resolve(__dirname, "../../data/good-tokens.json");

export interface GoodToken {
  chain: string;
  address: string;
  symbol?: string;
  peakMcap?: number;
  addedAt: string;
  addedBy?: string;
}

interface GoodTokenFile {
  tokens: GoodToken[];
}

export async function loadGoodTokens(): Promise<GoodToken[]> {
  try {
    return (JSON.parse(await readFile(PATH, "utf8")) as GoodTokenFile).tokens;
  } catch {
    return [];
  }
}

export async function saveGoodTokens(tokens: GoodToken[]): Promise<void> {
  await writeJsonAtomic(PATH, { tokens });
}

export async function addGoodToken(
  t: Omit<GoodToken, "addedAt">,
): Promise<{ added: boolean; tokens: GoodToken[] }> {
  const tokens = await loadGoodTokens();
  const key = (x: { chain: string; address: string }) =>
    `${x.chain.toLowerCase()}:${x.address.toLowerCase()}`;
  if (tokens.some((x) => key(x) === key(t))) return { added: false, tokens };
  tokens.push({ ...t, addedAt: new Date().toISOString() });
  await saveGoodTokens(tokens);
  return { added: true, tokens };
}

export async function goodTokensForChain(chain: string): Promise<GoodToken[]> {
  const c = chain.toLowerCase();
  return (await loadGoodTokens()).filter((t) => t.chain.toLowerCase() === c);
}
