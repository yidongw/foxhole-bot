import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sendDiscordMessage } from "../notify/discord.js";
import { resolveWebhook } from "../notify/routes.js";
import { fetchHot, onlyTwitter, searchNews, type OpenNewsItem } from "./opennews.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(__dirname, "../../data/opennews-state.json");

/** Keep at most this many recent ids to dedupe against (bounded state). */
const SEEN_CAP = 400;
/** Never post more than this many signals per tick (quota + spam guard). */
const CAP_PER_TICK = 6;

interface OpenNewsState {
  version: 1;
  seenIds: number[];
  lastRunAt?: string;
}

async function loadState(): Promise<OpenNewsState> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const s = JSON.parse(raw) as OpenNewsState;
    if (s.version === 1 && Array.isArray(s.seenIds)) return s;
  } catch {
    // first run
  }
  return { version: 1, seenIds: [] };
}

async function saveState(state: OpenNewsState): Promise<void> {
  state.seenIds = state.seenIds.slice(-SEEN_CAP);
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

const SIG = (s?: string) => (s === "long" ? "📈 多" : s === "short" ? "📉 空" : "· 中");

function format(it: OpenNewsItem): string {
  const grade = it.grade ? ` ${it.grade}` : "";
  const src = it.source ? ` (${it.source})` : "";
  const coins = it.coins?.length ? ` {${it.coins.slice(0, 6).join(",")}}` : "";
  const title = it.title.length > 240 ? it.title.slice(0, 240) + "…" : it.title;
  const link = it.link ? `\n${it.link}` : "";
  return `🛰️ **6551 [${it.score ?? "?"}${grade}] ${SIG(it.signal)}**${src}${coins}\n${title}${link}`;
}

export interface OpenNewsTickResult {
  fetched: number;
  posted: number;
}

/**
 * One 6551/OpenNews tick: pull AI-scored signals, keep only high-score
 * directional (long/short) ones, dedupe, and post to #news-radar.
 *
 * Uses the authed news_search when OPENNEWS_TOKEN is set (richer, directional);
 * otherwise falls back to the free hot feed (mostly neutral macro/twitter).
 * Quota-aware: bounded CAP_PER_TICK posts and a conservative poll interval.
 */
export async function openNewsTick(options: {
  dryRun?: boolean;
  webhookUrl?: string;
  minScore?: number;
}): Promise<OpenNewsTickResult> {
  const minScore = options.minScore ?? Number(process.env.OPENNEWS_MIN_SCORE ?? 80);
  const state = await loadState();
  const seen = new Set(state.seenIds);

  let items: OpenNewsItem[];
  try {
    const authed = await searchNews({ score: minScore, limit: 30 });
    // null → no token; throws on 401/402 (quota/auth). Either way fall back to
    // the free hot feed so the watcher degrades gracefully instead of erroring.
    items = authed ?? onlyTwitter(await fetchHot("web3"));
  } catch (err) {
    const msg = (err as Error).message;
    if (/\b(401|402|403|429)\b/.test(msg)) {
      console.warn(`opennews: authed search unavailable (${msg}) → free feed`);
      items = onlyTwitter(await fetchHot("web3"));
    } else {
      throw err;
    }
  }

  const fresh = items
    .filter((it) => (it.score ?? 0) >= minScore)
    .filter((it) => it.signal === "long" || it.signal === "short")
    .filter((it) => !seen.has(it.id))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  let posted = 0;
  const newsUrl = options.webhookUrl ?? resolveWebhook("news", "robinhood");
  for (const it of fresh.slice(0, CAP_PER_TICK)) {
    seen.add(it.id);
    state.seenIds.push(it.id);
    const msg = format(it);
    console.log(msg.replace(/\n/g, " · "));
    if (newsUrl && !options.dryRun) {
      await sendDiscordMessage(newsUrl, msg).catch((err) =>
        console.error("opennews post failed:", (err as Error).message),
      );
    }
    posted++;
  }
  // Mark the rest of this batch seen too, so a later score change doesn't
  // resurface an item we already evaluated and dropped.
  for (const it of items) if (!seen.has(it.id)) { seen.add(it.id); state.seenIds.push(it.id); }

  state.lastRunAt = new Date().toISOString();
  await saveState(state);
  return { fetched: items.length, posted };
}
