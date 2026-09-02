import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SignalEvaluation } from "../signals/types.js";
import { resolveWebhook } from "./routes.js";

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
  await mkdir(path.dirname(THREADS_PATH), { recursive: true });
  await writeFile(THREADS_PATH, JSON.stringify(map, null, 2), "utf8");
}

const GMGN_CHAIN: Record<string, string> = {
  solana: "sol",
  bsc: "bsc",
  base: "base",
  ethereum: "eth",
};

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
    `最新: $${i.priceUsd?.toPrecision(4) ?? "?"} · 流动性 $${((i.liquidityUsd ?? 0) / 1e3).toFixed(0)}K · 触发器 ${ev.triggers.slice(0, 3).join(",")}`,
  );
  return lines.join("\n");
}

/** Per-trigger detail for the thread. */
function formatDetail(ev: SignalEvaluation): string {
  const i = ev.input;
  return [
    `**触发 #${new Date().toISOString().slice(11, 16)} UTC** — score ${ev.score}`,
    `原因: ${ev.reasons.join(" · ")}`,
    `价格 $${i.priceUsd?.toPrecision(4) ?? "?"} · 24h量 $${((i.volume24hUsd ?? 0) / 1e6).toFixed(2)}M · 流动性 $${((i.liquidityUsd ?? 0) / 1e3).toFixed(0)}K` +
      (i.quoteLockRatio != null ? ` · 锁仓 ${(i.quoteLockRatio * 100).toFixed(0)}%` : "") +
      (i.curveProgress != null ? ` · 曲线 ${(i.curveProgress * 100).toFixed(0)}%` : ""),
  ].join("\n");
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

  try {
    let entry = map[key];
    if (!entry) {
      // 1. parent card via webhook (?wait=true → message id)
      entry = { messageId: "", threadId: "", symbol: ev.input.symbol, firstAt: now, lastAt: now, count: 1 };
      const res = await fetch(`${webhook}?wait=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: formatCard(ev, entry) }),
      });
      if (!res.ok) return false;
      const msg = (await res.json()) as { id: string };
      entry.messageId = msg.id;

      // 2. open the thread off the card
      const tres = await discordApi(
        `/channels/${channelId}/messages/${msg.id}/threads`,
        "POST",
        { name: `${ev.input.symbol ?? ev.input.address.slice(0, 8)}·${chain}` },
      );
      if (tres.ok) {
        entry.threadId = ((await tres.json()) as { id: string }).id;
      }
      map[key] = entry;
      await saveMap(map);
    } else {
      // repeat trigger: bump card + count
      entry.count += 1;
      entry.lastAt = now;
      await fetch(`${webhook}/messages/${entry.messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: formatCard(ev, entry) }),
      }).catch(() => {});
      await saveMap(map);
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
