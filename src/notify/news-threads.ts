import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "../lib/atomic-json.js";
import { resolveWebhook } from "./routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THREADS_PATH = path.resolve(__dirname, "../../data/news-threads.json");

/**
 * 一个「待研究信号」= #news-radar 里一张卡片 + 一条 thread，按币名归档。
 * 用于表面值得交易、但快讯里没有合约地址的信号 —— trade-signal 频道进不去
 * （那里每张卡片必须有 CA），但又不能只甩一条平消息埋掉。开 thread 后
 * AI decider 去里面深挖：查合约、研究、判断值不值得做，结论写回同一 thread。
 */

interface NewsThreadEntry {
  messageId: string;
  threadId: string;
  symbol: string;
  firstAt: string;
  lastAt: string;
  count: number;
}

type NewsThreadMap = Record<string, NewsThreadEntry>;

async function loadMap(): Promise<NewsThreadMap> {
  try {
    return JSON.parse(await readFile(THREADS_PATH, "utf8")) as NewsThreadMap;
  } catch {
    return {};
  }
}

async function saveMap(map: NewsThreadMap): Promise<void> {
  await writeJsonAtomic(THREADS_PATH, map);
}

function ts(iso: string): string {
  return `<t:${Math.floor(new Date(iso).getTime() / 1000)}:R>`;
}

async function discordApi(pathname: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`https://discord.com/api/v10${pathname}`, {
    method,
    headers: {
      Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// #news-radar 的 channel id — 从 webhook 反查一次后缓存（不必单独配 env）
let cachedChannelId: string | undefined;
async function newsChannelId(webhook: string): Promise<string | undefined> {
  if (cachedChannelId) return cachedChannelId;
  try {
    const res = await fetch(webhook);
    if (!res.ok) return undefined;
    cachedChannelId = ((await res.json()) as { channel_id?: string }).channel_id;
    return cachedChannelId;
  } catch {
    return undefined;
  }
}

async function subscribeOwner(threadId: string): Promise<void> {
  const owner = process.env.DISCORD_OWNER_USER_ID;
  if (!owner || !threadId) return;
  try {
    await discordApi(`/channels/${threadId}/thread-members/${owner}`, "PUT");
  } catch {
    // non-fatal
  }
}

function formatCard(symbol: string, firstAt: string, reasons: string[], headline: string): string {
  return [
    `📰🛰️ **${symbol}** — 新闻信号·待研究`,
    `触发: ${reasons.join(", ") || "keyword"}`,
    `首条: ${ts(firstAt)} — ${headline}`,
    `无合约地址，需 AI 深挖: 找 CA → 查行情 → 判断值不值得做，结论写进本 thread。`,
  ].join("\n");
}

/** decider 先出结论、快讯时没开 thread 的兜底卡片（如 stoplist 词 MEME）。 */
function formatResearchCard(symbol: string, firstAt: string): string {
  return [
    `📰🛰️ **${symbol}** — 新闻信号·AI 研究`,
    `首条: ${ts(firstAt)}`,
    `AI 深挖结论见本 thread。`,
  ].join("\n");
}

/**
 * 开（或复用）某币的 news-radar 卡片+thread，返回 thread 条目。
 * cardText 只在**首次**建 thread 时用作卡片正文。缺 token/webhook/channel 返回 undefined。
 */
async function ensureResearchThread(
  webhook: string,
  symbol: string,
  cardText: string,
): Promise<NewsThreadEntry | undefined> {
  if (!process.env.DISCORD_BOT_TOKEN) return undefined;
  const channelId = await newsChannelId(webhook);
  if (!channelId) return undefined;

  const key = symbol.toLowerCase();
  const map = await loadMap();
  const now = new Date().toISOString();
  const existing = map[key];

  if (existing?.threadId) {
    existing.count += 1;
    existing.lastAt = now;
    await saveMap(map);
    return existing;
  }

  const entry: NewsThreadEntry = {
    messageId: "",
    threadId: "",
    symbol,
    firstAt: now,
    lastAt: now,
    count: 1,
  };
  const res = await fetch(`${webhook}?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: cardText }),
  });
  if (!res.ok) return undefined;
  entry.messageId = ((await res.json()) as { id: string }).id;
  const tres = await discordApi(
    `/channels/${channelId}/messages/${entry.messageId}/threads`,
    "POST",
    { name: `${symbol}·研究` },
  );
  if (!tres.ok) return undefined;
  entry.threadId = ((await tres.json()) as { id: string }).id;
  await subscribeOwner(entry.threadId);
  map[key] = entry;
  await saveMap(map);
  return entry;
}

async function postToThread(webhook: string, threadId: string, body: string): Promise<boolean> {
  const res = await fetch(`${webhook}?thread_id=${threadId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: body }),
  }).catch(() => undefined);
  return Boolean(res?.ok);
}

/**
 * 开（或复用）一个待研究信号的 news-radar 卡片+thread，把首条新闻发进去。
 * 返回 true = thread 模式已投递；false = 缺 token/webhook，调用方回落平消息。
 */
export async function postNewsResearchThread(
  symbol: string,
  reasons: string[],
  headline: string,
  body: string,
): Promise<boolean> {
  const webhook = resolveWebhook("news", "robinhood");
  if (!webhook) return false;
  try {
    const entry = await ensureResearchThread(
      webhook,
      symbol,
      formatCard(symbol, new Date().toISOString(), reasons, headline),
    );
    if (!entry?.threadId) return false;
    return await postToThread(webhook, entry.threadId, body);
  } catch (err) {
    console.error("news research thread failed:", (err as Error).message);
    return false;
  }
}

/**
 * 把 AI 的研究结论发进某个币的 news-radar thread（decider 用）。
 * 快讯时因 stoplist 等原因没开 thread 时**按需新建**，让结论永远落进 thread 而非平消息。
 */
export async function postToNewsResearchThread(
  symbol: string,
  body: string,
): Promise<boolean> {
  const webhook = resolveWebhook("news", "robinhood");
  if (!webhook) return false;
  try {
    const entry = await ensureResearchThread(
      webhook,
      symbol,
      formatResearchCard(symbol, new Date().toISOString()),
    );
    if (!entry?.threadId) return false;
    return await postToThread(webhook, entry.threadId, body);
  } catch (err) {
    console.error("news research thread (note) failed:", (err as Error).message);
    return false;
  }
}
