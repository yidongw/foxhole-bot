import { readFile, mkdir, writeFile } from "node:fs/promises";
import { writeJsonAtomic } from "../lib/atomic-json.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SignalEvaluation } from "../signals/types.js";
import { resolveWebhook } from "./routes.js";
import { fdvTag, GMGN_SLUG as GMGN_CHAIN } from "../lib/format.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THREADS_PATH = path.resolve(__dirname, "../../data/signal-threads.json");

/**
 * One thread per token in the 🎯 trade-signal channels:
 * - first trigger → parent message (static card) + auto-created thread with
 *   the trigger detail
 * - repeat triggers → EDIT the parent card ("🔁 第N次触发 · <t:..:R>") and
 *   post detail into the thread — one channel slot per token, activity
 *   still bubbles up (bold channel + message count)
 * - AI decisions and trade events post into the same thread
 *
 * Threads need DISCORD_BOT_TOKEN; without it we fall back to flat messages.
 */

const SIGNAL_CHANNEL_IDS: Record<string, string> = {
  robinhood: "1544660493887610910",
  ethereum: "1544700576087015545",
  bsc: "1544700920577790032",
  solana: "1544701167291080734",
  base: "1544701578466820206",
};

interface ThreadEntry {
  messageId: string;
  threadId: string;
  symbol?: string;
  firstAt: string;
  lastAt: string;
  count: number;
}

type ThreadMap = Record<string, ThreadEntry>;

async function loadMap(): Promise<ThreadMap> {
  try {
    return JSON.parse(await readFile(THREADS_PATH, "utf8")) as ThreadMap;
  } catch {
    return {};
  }
}

async function saveMap(map: ThreadMap): Promise<void> {
  await writeJsonAtomic(THREADS_PATH, map);
}

function ts(iso: string, style: "R" | "f" = "R"): string {
  return `<t:${Math.floor(new Date(iso).getTime() / 1000)}:${style}>`;
}

/** Static card + editable status line. */
function formatCard(ev: SignalEvaluation, entry: ThreadEntry): string {
  const i = ev.input;
  const chain = i.chain ?? "robinhood";
  const links = [
    `[📈 DexScreener](https://dexscreener.com/${chain}/${i.primaryPairAddress ?? i.address})`,
  ];
  if (GMGN_CHAIN[chain]) {
    links.push(`[🔍 GMGN](https://gmgn.ai/${GMGN_CHAIN[chain]}/token/${i.address})`);
  }
  if (i.primaryPairAddress) {
    links.push(
      `[🦎 GT](https://www.geckoterminal.com/${chain === "ethereum" ? "eth" : chain}/pools/${i.primaryPairAddress})`,
    );
  }
  if (chain === "robinhood") {
    links.push(
      `[🔗 Explorer](https://robinhoodchain.blockscout.com/token/${i.address})`,
      `[🏠 Long](https://app.long.xyz/tokens/${i.address})`,
    );
  }
  const lines = [
    `🎯 **${i.symbol ?? "?"}** [${chain.toUpperCase()}] — ${i.primaryPair ?? ""}`,
    `CA: \`${i.address}\``,
    links.join(" · "),
  ];
  if (i.launchAt) lines.push(`发射: ${ts(i.launchAt, "f")} (${ts(i.launchAt)})`);
  lines.push(
    `首次触发: ${ts(entry.firstAt)}` +
      (entry.count > 1 ? ` · 🔁 **第 ${entry.count} 次触发** ${ts(entry.lastAt)}` : ""),
  );
  lines.push(
    `最新: $${i.priceUsd?.toPrecision(4) ?? "?"} · 流动性 $${((i.liquidityUsd ?? 0) / 1e3).toFixed(0)}K${fdvTag(i.fdvUsd)} · 触发器 ${ev.triggers.slice(0, 3).join(",")}`,
  );
  return lines.join("\n");
}

/** Per-trigger detail for the thread. */
function formatDetail(ev: SignalEvaluation): string {
  const i = ev.input;
  return [
    `**触发 #${new Date().toISOString().slice(11, 16)} UTC** — score ${ev.score}`,
    `原因: ${ev.reasons.join(" · ")}`,
    `价格 $${i.priceUsd?.toPrecision(4) ?? "?"} · 24h量 $${((i.volume24hUsd ?? 0) / 1e6).toFixed(2)}M · 流动性 $${((i.liquidityUsd ?? 0) / 1e3).toFixed(0)}K${fdvTag(i.fdvUsd)}` +
      (i.quoteLockRatio != null ? ` · 锁仓 ${(i.quoteLockRatio * 100).toFixed(0)}%` : "") +
      (i.curveProgress != null ? ` · 曲线 ${(i.curveProgress * 100).toFixed(0)}%` : ""),
  ].join("\n");
}

/**
 * Subscribe the owner to a token thread so updates reach their inbox —
 * threads the user never joined don't notify them at all.
 */
async function addOwnerToThread(threadId: string): Promise<void> {
  const owner = process.env.DISCORD_OWNER_USER_ID;
  if (!owner || !threadId) return;
  try {
    await discordApi(`/channels/${threadId}/thread-members/${owner}`, "PUT");
  } catch {
    // non-fatal: the thread still works, the user just isn't auto-joined
  }
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

/**
 * Post (or update) a token's signal card + thread. Returns true when
 * thread-mode handled delivery; false → caller should fall back to flat.
 */
export async function postThreadedSignal(ev: SignalEvaluation): Promise<boolean> {
  const chain = ev.input.chain ?? "robinhood";
  const webhook = resolveWebhook("signal", chain);
  const channelId = SIGNAL_CHANNEL_IDS[chain];
  if (!webhook || !channelId || !process.env.DISCORD_BOT_TOKEN) return false;

  const key = `${chain}:${ev.input.address.toLowerCase()}`;
  const map = await loadMap();
  const now = new Date().toISOString();

  const createThreadOffCard = async (entry: ThreadEntry): Promise<void> => {
    const tres = await discordApi(
      `/channels/${channelId}/messages/${entry.messageId}/threads`,
      "POST",
      { name: `${ev.input.symbol ?? ev.input.address.slice(0, 8)}·${chain}` },
    );
    if (tres.ok) {
      entry.threadId = ((await tres.json()) as { id: string }).id;
      await addOwnerToThread(entry.threadId);
    }
  };

  const createCard = async (): Promise<ThreadEntry | undefined> => {
    const entry: ThreadEntry = {
      messageId: "",
      threadId: "",
      symbol: ev.input.symbol,
      firstAt: now,
      lastAt: now,
      count: 1,
    };
    const res = await fetch(`${webhook}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: formatCard(ev, entry) }),
    });
    if (!res.ok) return undefined;
    entry.messageId = ((await res.json()) as { id: string }).id;
    await createThreadOffCard(entry);
    map[key] = entry;
    await saveMap(map);
    return entry;
  };

  try {
    let entry: ThreadEntry | undefined = map[key];
    if (!entry) {
      entry = await createCard();
      if (!entry) return false;
    } else {
      // repeat trigger: bump card + count
      entry.count += 1;
      entry.lastAt = now;
      const patch = await fetch(`${webhook}/messages/${entry.messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: formatCard(ev, entry) }),
      }).catch(() => undefined);
      if (patch && (patch.status === 404 || patch.status === 403)) {
        // card was deleted manually — heal by rebuilding it
        delete map[key];
        entry = await createCard();
        if (!entry) return false;
      } else {
        if (!entry.threadId) await createThreadOffCard(entry); // heal missing thread
        await saveMap(map);
      }
    }

    // 3. detail into the thread
    if (entry.threadId) {
      await fetch(`${webhook}?thread_id=${entry.threadId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: formatDetail(ev) }),
      });
    }
    return true;
  } catch (err) {
    console.error("threaded signal failed:", (err as Error).message);
    return false;
  }
}

/** Find an existing token card/thread by symbol (case-insensitive). */
export async function findSignalThreadBySymbol(
  symbol: string,
): Promise<{ chain: string; address: string } | undefined> {
  const map = await loadMap();
  const needle = symbol.toLowerCase();
  for (const [key, entry] of Object.entries(map)) {
    if (entry.symbol?.toLowerCase() === needle && entry.threadId) {
      const idx = key.indexOf(":");
      return { chain: key.slice(0, idx), address: key.slice(idx + 1) };
    }
  }
  return undefined;
}

/** 新闻来源卡片（无链上评分，只有 token 身份 + 首条新闻）。 */
function formatNewsCard(
  ref: { chain: string; address: string; symbol?: string },
  entry: ThreadEntry,
  headline: string,
): string {
  const { chain, address } = ref;
  const links = [`[📈 DexScreener](https://dexscreener.com/${chain}/${address})`];
  if (GMGN_CHAIN[chain]) {
    links.push(`[🔍 GMGN](https://gmgn.ai/${GMGN_CHAIN[chain]}/token/${address})`);
  }
  if (chain === "robinhood") {
    links.push(
      `[🔗 Explorer](https://robinhoodchain.blockscout.com/token/${address})`,
      `[🏠 Long](https://app.long.xyz/tokens/${address})`,
    );
  }
  return [
    `📰 **${ref.symbol ?? "?"}** [${chain.toUpperCase()}] — 新闻来源`,
    `CA: \`${address}\``,
    links.join(" · "),
    `首条新闻: ${ts(entry.firstAt)} — ${headline}`,
  ].join("\n");
}

/**
 * 为一条新闻的 token 开（或复用）trade-signal 卡片+thread，把新闻发进去。
 * 只有“值得”的新闻才该调用（调用方判定：关注币/负面/上所/动能 + 解析出了地址）。
 * 返回 true = thread 模式已投递；false = 调用方回落 #news-radar。
 */
export async function postNewsCardThread(
  ref: { chain: string; address: string; symbol?: string },
  headline: string,
  body: string,
): Promise<boolean> {
  const chain = ref.chain;
  const webhook = resolveWebhook("signal", chain);
  const channelId = SIGNAL_CHANNEL_IDS[chain];
  if (!webhook || !channelId || !process.env.DISCORD_BOT_TOKEN) return false;

  const key = `${chain}:${ref.address.toLowerCase()}`;
  const map = await loadMap();
  const now = new Date().toISOString();
  let entry = map[key];

  try {
    if (!entry?.threadId) {
      entry = {
        messageId: "",
        threadId: "",
        symbol: ref.symbol,
        firstAt: now,
        lastAt: now,
        count: 1,
      };
      const res = await fetch(`${webhook}?wait=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: formatNewsCard(ref, entry, headline) }),
      });
      if (!res.ok) return false;
      entry.messageId = ((await res.json()) as { id: string }).id;
      const tres = await discordApi(
        `/channels/${channelId}/messages/${entry.messageId}/threads`,
        "POST",
        { name: `${ref.symbol ?? ref.address.slice(0, 8)}·${chain}` },
      );
      if (!tres.ok) return false;
      entry.threadId = ((await tres.json()) as { id: string }).id;
      map[key] = entry;
      await saveMap(map);
    }
    const res = await fetch(`${webhook}?thread_id=${entry.threadId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: body }),
    }).catch(() => undefined);
    return Boolean(res?.ok);
  } catch (err) {
    console.error("news card thread failed:", (err as Error).message);
    return false;
  }
}

/** Post trade/AI activity into a token's signal thread (best-effort). */
export async function postToSignalThread(
  chain: string,
  address: string,
  body: string,
): Promise<boolean> {
  const webhook = resolveWebhook("signal", chain);
  if (!webhook) return false;
  const map = await loadMap();
  const entry = map[`${chain}:${address.toLowerCase()}`];
  if (!entry?.threadId) return false;
  const res = await fetch(`${webhook}?thread_id=${entry.threadId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: body }),
  }).catch(() => undefined);
  return Boolean(res?.ok);
}

/**
 * Ensure a per-token signal card + thread exists (keyed chain:address) and post
 * `cardBody`. Used by smart-money trade signals so the AI decider's later
 * `note` (postToSignalThread) has a thread to write into. Returns false — so
 * the caller can fall back to a flat message — when the chain has no signal
 * channel id or DISCORD_BOT_TOKEN is unset.
 */
export async function ensureSignalThread(
  chain: string,
  address: string,
  symbol: string | undefined,
  cardBody: string,
): Promise<boolean> {
  const webhook = resolveWebhook("signal", chain);
  const channelId = SIGNAL_CHANNEL_IDS[chain];
  if (!webhook || !channelId || !process.env.DISCORD_BOT_TOKEN) return false;
  const key = `${chain}:${address.toLowerCase()}`;
  const map = await loadMap();
  const now = new Date().toISOString();
  try {
    let entry = map[key];
    if (entry?.threadId) {
      await fetch(`${webhook}?thread_id=${entry.threadId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: cardBody }),
      });
      return true;
    }
    const res = await fetch(`${webhook}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: cardBody }),
    });
    if (!res.ok) return false;
    const messageId = ((await res.json()) as { id: string }).id;
    entry = { messageId, threadId: "", symbol, firstAt: now, lastAt: now, count: 1 };
    const tres = await discordApi(
      `/channels/${channelId}/messages/${messageId}/threads`,
      "POST",
      { name: `${symbol ?? address.slice(0, 8)}·${chain}` },
    );
    if (tres.ok) {
      entry.threadId = ((await tres.json()) as { id: string }).id;
      await addOwnerToThread(entry.threadId);
    }
    map[key] = entry;
    await saveMap(map);
    return Boolean(entry.threadId);
  } catch (err) {
    console.error("ensureSignalThread failed:", (err as Error).message);
    return false;
  }
}
