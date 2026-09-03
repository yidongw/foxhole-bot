import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "../lib/atomic-json.js";
import type { StockAsset } from "../chains/robinhood/stock-registry.js";

/**
 * "New official RH stock listed" alerts — one thread per stock in the
 * #new-stocks channel. This is the precondition feed for the tokenized-stock
 * squeeze play: a fresh listing means someone can now legitimately pair a meme
 * against a real stock token. Memes themselves stay in the trade-signal
 * channel (they'd be duplicated here) — this channel answers "which stock is
 * the arena", the trade signal answers "which meme".
 *
 * Posts via the bot API (needs DISCORD_BOT_TOKEN) so it can open a thread off
 * the card; falls back to a flat DISCORD_STOCK_WEBHOOK_URL post, else stdout.
 */

const STOCK_CHANNEL_ID = "1544959136188469391";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THREADS_PATH = path.resolve(__dirname, "../../data/stock-threads.json");

interface StockThreadEntry {
  messageId: string;
  threadId: string;
  firstAt: string;
}

type ThreadMap = Record<string, StockThreadEntry>;

async function loadMap(): Promise<ThreadMap> {
  try {
    return JSON.parse(await readFile(THREADS_PATH, "utf8")) as ThreadMap;
  } catch {
    return {};
  }
}

function formatStockCard(stock: StockAsset): string {
  const links: string[] = [];
  if (stock.address) {
    links.push(
      `[🔗 Explorer](https://robinhoodchain.blockscout.com/token/${stock.address})`,
      `[📈 DexScreener](https://dexscreener.com/robinhood/${stock.address})`,
    );
  }
  const lines = [
    `🆕 **新官方 RH 股票代币上榜** — ${stock.symbol}`,
    stock.name ?? "",
    stock.address ? `CA: \`${stock.address}\`` : "",
    links.join(" · "),
    "⚠️ 真轧空玩法前置条件已就位 — 盯配对它发的 meme",
  ];
  return lines.filter(Boolean).join("\n");
}

async function discordApi(
  pathname: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`https://discord.com/api/v10${pathname}`, {
    method,
    headers: {
      Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function addOwnerToThread(threadId: string): Promise<void> {
  const owner = process.env.DISCORD_OWNER_USER_ID;
  if (!owner || !threadId) return;
  try {
    await discordApi(`/channels/${threadId}/thread-members/${owner}`, "PUT");
  } catch {
    // non-fatal: the thread still works, the user just isn't auto-joined
  }
}

/**
 * Post a new-stock card + open its thread. Deduped by symbol via the thread
 * map. Returns true when delivered (thread or flat), false when it could only
 * print to stdout / failed.
 */
export async function postNewStock(stock: StockAsset): Promise<boolean> {
  const card = formatStockCard(stock);
  const key = stock.symbol.toUpperCase();

  if (!process.env.DISCORD_BOT_TOKEN) {
    const webhook = process.env.DISCORD_STOCK_WEBHOOK_URL;
    if (webhook) {
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: card }),
      }).catch(() => undefined);
      return Boolean(res?.ok);
    }
    console.log(`[new stock] ${card}`);
    return false;
  }

  const map = await loadMap();
  if (map[key]?.threadId) return true; // already announced

  try {
    const msgRes = await discordApi(
      `/channels/${STOCK_CHANNEL_ID}/messages`,
      "POST",
      { content: card },
    );
    if (!msgRes.ok) {
      console.error(`new-stock post failed ${key}: ${msgRes.status}`);
      return false;
    }
    const messageId = ((await msgRes.json()) as { id: string }).id;
    const entry: StockThreadEntry = {
      messageId,
      threadId: "",
      firstAt: new Date().toISOString(),
    };
    const tres = await discordApi(
      `/channels/${STOCK_CHANNEL_ID}/messages/${messageId}/threads`,
      "POST",
      { name: `${stock.symbol}·RB` },
    );
    if (tres.ok) {
      entry.threadId = ((await tres.json()) as { id: string }).id;
      await addOwnerToThread(entry.threadId);
    }
    map[key] = entry;
    await writeJsonAtomic(THREADS_PATH, map);
    return true;
  } catch (err) {
    console.error("new-stock thread failed:", (err as Error).message);
    return false;
  }
}
