import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendAiInboxNews } from "../notify/ai-inbox.js";
import { sendDiscordMessage } from "../notify/discord.js";
import { resolveWebhook } from "../notify/routes.js";
import {
  findSignalThreadBySymbol,
  postToSignalThread,
} from "../notify/signal-threads.js";
import type { LaunchesPayload } from "../types.js";
import {
  archiveFlashes,
  fetchLatestFlashId,
  fetchNewFlashes,
  type Flash,
} from "./blockbeats.js";
import {
  classifyFlash,
  extractSymbols,
  usableSymbols,
  type NewsClassification,
} from "./filter.js";
import { judgeFlash } from "./judge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(__dirname, "../../data/news-state.json");
const LAUNCHES_PATH = path.resolve(__dirname, "../../data/launches.json");

/** First tick backfills this many flashes so a restart never misses a burst. */
const FIRST_RUN_BACKFILL = 15;
const CAP_PER_TICK = 30;

/** 热点币记忆：wake 快讯里提到的 symbol 保留 48h，后续新闻直接命中关注表。 */
const HOT_SYMBOL_TTL_MS = 48 * 60 * 60 * 1000;

interface NewsState {
  version: 1;
  lastId: number;
  lastRunAt?: string;
  /** symbol -> last seen ISO timestamp */
  hotSymbols?: Record<string, string>;
}

async function loadNewsState(): Promise<NewsState> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const state = JSON.parse(raw) as NewsState;
    if (state.version === 1 && typeof state.lastId === "number") return state;
  } catch {
    // first run
  }
  return { version: 1, lastId: 0 };
}

async function saveNewsState(state: NewsState): Promise<void> {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

async function loadWatchedSymbols(): Promise<string[]> {
  try {
    const raw = await readFile(LAUNCHES_PATH, "utf8");
    const payload = JSON.parse(raw) as LaunchesPayload;
    return usableSymbols(payload.launches.map((l) => l.symbol));
  } catch {
    return [];
  }
}

function formatWakeAlert(
  flash: Flash,
  cls: NewsClassification,
  verdict?: { urgency: "now" | "watch"; note: string },
): string {
  const head = cls.negative ? "⚠️ **NEWS EXIT/RISK**" : "📰 **NEWS SIGNAL**";
  const urgency = verdict?.urgency === "now" ? " 🔥" : "";
  const lines = [
    `${head}${urgency} ${flash.title}`,
    `触发: ${cls.reasons.join(", ") || "keyword"}`,
  ];
  if (verdict?.note) lines.push(`🧠 ${verdict.note}`);
  lines.push(flash.url);
  return lines.join("\n");
}

export interface NewsTickResult {
  fetched: number;
  woke: number;
  noted: number;
}

/**
 * One news tick: pull new BlockBeats flashes, archive, classify, wake.
 * wake 候选先过 Claude 判定（fail-open）；signal=false 的降级进 filter-log。
 */
export async function newsTick(options: {
  dryRun?: boolean;
  webhookUrl?: string;
}): Promise<NewsTickResult> {
  const state = await loadNewsState();

  if (!state.lastId) {
    const latest = await fetchLatestFlashId();
    if (!latest) return { fetched: 0, woke: 0, noted: 0 };
    state.lastId = Math.max(0, latest - FIRST_RUN_BACKFILL);
  }

  const { flashes, latestId } = await fetchNewFlashes(state.lastId, CAP_PER_TICK);
  state.lastId = latestId;
  state.lastRunAt = new Date().toISOString();
  await saveNewsState(state);
  if (!flashes.length) return { fetched: 0, woke: 0, noted: 0 };

  await archiveFlashes(flashes).catch((err) =>
    console.error("news archive failed:", (err as Error).message),
  );

  const now = Date.now();
  state.hotSymbols = Object.fromEntries(
    Object.entries(state.hotSymbols ?? {}).filter(
      ([, seen]) => now - new Date(seen).getTime() < HOT_SYMBOL_TTL_MS,
    ),
  );
  const watched = [
    ...new Set([...(await loadWatchedSymbols()), ...Object.keys(state.hotSymbols)]),
  ];
  const filterUrl = options.webhookUrl ?? resolveWebhook("filter", "robinhood");

  let woke = 0;
  let noted = 0;
  for (const flash of flashes) {
    // 标题+正文一起匹配 — “microduck市值突破3200万”标题不带链名，
    // 但正文里有“Robinhood 生态 Meme 币”（2026-09-02 复盘教训）
    const cls = classifyFlash(flash.title, watched, flash.content);
    if (cls.action === "drop") continue;

    if (cls.action === "wake") {
      // 只从标题提取 — 正文会把 GMGN 这类数据源名也带进来
      for (const sym of extractSymbols(flash.title)) {
        state.hotSymbols[sym] = new Date().toISOString();
      }
      const verdict = await judgeFlash(flash, cls);
      if (verdict && !verdict.signal) {
        // Claude 否决 → 留痕但不叫醒
        if (filterUrl && !options.dryRun) {
          await sendDiscordMessage(
            filterUrl,
            `📰🚫 ${flash.title}\n判定: ${verdict.note || "非交易信号"} | ${flash.url}`,
          ).catch((err) => console.error("news filter post failed:", err.message));
        }
        noted++;
        continue;
      }
      const msg = formatWakeAlert(flash, cls, verdict);
      console.log(msg.replace(/\n/g, " · "));
      if (!options.dryRun) {
        // 投递 AI 收件箱 — wake-probe 会叫醒 Claude 会话来判断买/卖/跳过
        await appendAiInboxNews({
          title: flash.title,
          url: flash.url,
          reasons: cls.reasons,
          negative: cls.negative,
          note: verdict?.note,
        }).catch((err) => console.error("news inbox append failed:", err.message));

        // trade-signal 频道是分币的（每币一张卡片+thread）—— 新闻只允许
        // 发进已有卡片的币的 thread；对不上的去 filter-log，不发散消息
        const candidateSymbols = [
          ...(cls.reasons
            .find((r) => r.startsWith("watched:"))
            ?.slice("watched:".length)
            .split("+") ?? []),
          ...extractSymbols(flash.title),
        ];
        let delivered = false;
        for (const sym of [...new Set(candidateSymbols)]) {
          const thread = await findSignalThreadBySymbol(sym).catch(() => undefined);
          if (!thread) continue;
          delivered = await postToSignalThread(thread.chain, thread.address, msg);
          if (delivered) break;
        }
        if (!delivered && filterUrl) {
          await sendDiscordMessage(filterUrl, msg).catch((err) =>
            console.error("news filter post failed:", err.message),
          );
        }
      }
      woke++;
    } else {
      if (filterUrl && !options.dryRun) {
        await sendDiscordMessage(
          filterUrl,
          `📰 ${flash.title}\n${cls.reasons.join(", ")} | ${flash.url}`,
        ).catch((err) => console.error("news note post failed:", err.message));
      }
      noted++;
    }
  }
  // 第二次落盘带上更新后的热点币（第一次只为 lastId 崩溃安全）
  await saveNewsState(state);
  return { fetched: flashes.length, woke, noted };
}
