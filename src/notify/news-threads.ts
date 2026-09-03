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

function formatCard(entry: NewsThreadEntry, reasons: string[], headline: string): string {
  return [
    `📰🛰️ **${entry.symbol}** — 新闻信号·待研究`,
    `触发: ${reasons.join(", ") || "keyword"}`,
    `首条: ${ts(entry.firstAt)} — ${headline}`,
    `无合约地址，需 AI 深挖: 找 CA → 查行情 → 判断值不值得做，结论写进本 thread。`,
  ].join("\n");
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
  if (!webhook || !process.env.DISCORD_BOT_TOKEN) return false;
  const channelId = await newsChannelId(webhook);
  if (!channelId) return false;

  const key = symbol.toLowerCase();
  const map = await loadMap();
  const now = new Date().toISOString();
  let entry = map[key];

  try {
    if (!entry?.threadId) {
      entry = { messageId: "", threadId: "", symbol, firstAt: now, lastAt: now, count: 1 };
      const res = await fetch(`${webhook}?wait=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: formatCard(entry, reasons, headline) }),
      });
      if (!res.ok) return false;
      entry.messageId = ((await res.json()) as { id: string }).id;
      const tres = await discordApi(
        `/channels/${channelId}/messages/${entry.messageId}/threads`,
        "POST",
        { name: `${symbol}·研究` },
      );
      if (!tres.ok) return false;
      entry.threadId = ((await tres.json()) as { id: string }).id;
      await subscribeOwner(entry.threadId);
      map[key] = entry;
    } else {
      entry.count += 1;
      entry.lastAt = now;
    }
    await saveMap(map);
    const res = await fetch(`${webhook}?thread_id=${entry.threadId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: body }),
    }).catch(() => undefined);
    return Boolean(res?.ok);
  } catch (err) {
    console.error("news research thread failed:", (err as Error).message);
    return false;
  }
}

/** 把 AI 的研究结论发进某个币的 news-radar thread（decider 用）。 */
export async function postToNewsResearchThread(
  symbol: string,
  body: string,
): Promise<boolean> {
  const webhook = resolveWebhook("news", "robinhood");
  if (!webhook) return false;
  const entry = (await loadMap())[symbol.toLowerCase()];
  if (!entry?.threadId) return false;
  const res = await fetch(`${webhook}?thread_id=${entry.threadId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: body }),
  }).catch(() => undefined);
  return Boolean(res?.ok);
}
