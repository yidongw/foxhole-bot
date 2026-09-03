import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = path.resolve(__dirname, "../../data/news");

const LIST_URL = "https://www.theblockbeats.info/newsflash";
const FLASH_URL = (id: number) => `https://www.theblockbeats.info/flash/${id}`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

// 官方 API（免费 Key: theblockbeats.info/apiDoc → 申请 Key,免费额度 10000 次）
const API_BASE = "https://api-pro.theblockbeats.info/v1";

function apiKey(): string | undefined {
  return process.env.BLOCKBEATS_API_KEY || undefined;
}

/**
 * BlockBeats（区块律动）快讯抓取。
 *
 * 有 BLOCKBEATS_API_KEY 时走官方接口（/v1/newsflash + /v1/search，
 * 鉴权是 `api-key` 请求头）；没有或接口失败时退回 SSR 页面抓取：
 * 快讯 ID 严格递增，列表页取最新 ID，再逐条抓详情页。
 */
export interface Flash {
  id: number;
  title: string;
  content?: string;
  url: string;
  fetchedAt: string;
}

export interface NewsSearchHit {
  /** 0 = 深度文章, 1 = 快讯 */
  type: number;
  title: string;
  content?: string;
  createTime: string;
  url?: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 每个进程只报一次 key 失效/额度耗尽 — 额度烧完换个邮箱再注册即可。 */
let keyProblemReported = false;

async function reportKeyProblem(detail: string): Promise<void> {
  if (keyProblemReported) return;
  keyProblemReported = true;
  console.error(`BlockBeats API key problem: ${detail}`);
  const { resolveWebhook } = await import("../notify/routes.js");
  const { sendDiscordMessage } = await import("../notify/discord.js");
  const url = resolveWebhook("news", "robinhood") ?? resolveWebhook("filter", "robinhood");
  if (url) {
    await sendDiscordMessage(
      url,
      `⚠️ **BLOCKBEATS KEY** 失效或额度耗尽（${detail}）— 轮询已自动退回页面抓取，` +
        `搜索/复盘对照会降级。用新邮箱注册一个 key 换上即可（找 Claude 代办）。`,
    ).catch(() => {});
  }
}

async function fetchApi(path: string, params: Record<string, string>): Promise<unknown> {
  const key = apiKey();
  if (!key) return undefined;
  try {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${API_BASE}${path}?${qs}`, {
      headers: { "api-key": key },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      await reportKeyProblem(`HTTP ${res.status}`);
      return undefined;
    }
    if (!res.ok) return undefined;
    const body = (await res.json()) as { status: number; message?: string; data?: unknown };
    if (body.status !== 0) {
      // status!=0 且 message 提到 key/额度 → 大概率要换 key 了
      if (/key|额度|限|quota|limit/i.test(body.message ?? "")) {
        await reportKeyProblem(body.message ?? `status ${body.status}`);
      }
      return undefined;
    }
    return body.data;
  } catch {
    return undefined;
  }
}

/** 官方接口拉最新快讯（id > sinceId），失败返回 undefined 让调用方走抓取。 */
async function fetchNewFlashesOfficial(
  sinceId: number,
  cap: number,
): Promise<{ flashes: Flash[]; latestId: number } | undefined> {
  const data = (await fetchApi("/newsflash", {
    page: "1",
    size: String(Math.min(cap, 50)),
    lang: "cn",
  })) as
    | { data?: Array<{ id: number; title: string; content?: string; link?: string }> }
    | undefined;
  const rows = data?.data;
  if (!rows?.length) return undefined;
  const now = new Date().toISOString();
  const flashes = rows
    .filter((r) => r.id > sinceId)
    .map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content ? stripHtml(r.content) : undefined,
      url: FLASH_URL(r.id),
      fetchedAt: now,
    }))
    .sort((a, b) => a.id - b.id);
  const latestId = Math.max(sinceId, ...rows.map((r) => r.id));
  return { flashes, latestId };
}

/** 官方关键词搜索（“查某个币的新闻”）。无 Key 或失败返回 undefined。 */
export async function searchNews(
  keyword: string,
  limit = 10,
): Promise<NewsSearchHit[] | undefined> {
  const data = (await fetchApi("/search", {
    name: keyword,
    page: "1",
    size: String(Math.min(limit, 100)),
  })) as
    | {
        data?: Array<{
          type: number;
          title: string;
          content?: string;
          create_time: string;
          url?: string;
        }>;
      }
    | undefined;
  if (!data?.data) return undefined;
  return data.data.map((r) => ({
    type: r.type,
    title: r.title,
    content: r.content,
    createTime: r.create_time,
    url: r.url,
  }));
}

async function fetchText(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    return await res.text();
  } catch {
    return undefined;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

/** Newest flash id from the SSR list page (ids are globally sequential). */
export async function fetchLatestFlashId(): Promise<number | undefined> {
  const html = await fetchText(LIST_URL);
  if (!html) return undefined;
  const ids = [...html.matchAll(/\/flash\/(\d{4,})/g)].map((m) => Number(m[1]));
  return ids.length ? Math.max(...ids) : undefined;
}

/** One flash by id; undefined when the id is a gap (deleted/unpublished). */
export async function fetchFlash(id: number): Promise<Flash | undefined> {
  const html = await fetchText(FLASH_URL(id));
  if (!html) return undefined;
  const t = html.match(/<title>([^<]+)<\/title>/);
  if (!t) return undefined;
  const title = decodeEntities(t[1]).replace(/\s*-\s*BlockBeats\s*$/, "");
  // Gap pages render the site default title
  if (!title || /^BlockBeats/.test(title)) return undefined;
  const d = html.match(/og:description"\s+content="([^"]{0,500})/);
  return {
    id,
    title,
    content: d ? decodeEntities(d[1]) : undefined,
    url: FLASH_URL(id),
    fetchedAt: new Date().toISOString(),
  };
}

/** All flashes with id in (sinceId, latest], oldest first, capped. */
export async function fetchNewFlashes(
  sinceId: number,
  cap = 30,
): Promise<{ flashes: Flash[]; latestId: number }> {
  const official = await fetchNewFlashesOfficial(sinceId, cap);
  if (official) return official;
  const latest = await fetchLatestFlashId();
  if (!latest || latest <= sinceId) return { flashes: [], latestId: sinceId };
  const from = Math.max(sinceId + 1, latest - cap + 1);
  const flashes: Flash[] = [];
  for (let id = from; id <= latest; id++) {
    const flash = await fetchFlash(id);
    if (flash) flashes.push(flash);
  }
  return { flashes, latestId: latest };
}

/** Append flashes to the local monthly archive (data/news/YYYY-MM.jsonl). */
export async function archiveFlashes(flashes: Flash[]): Promise<void> {
  if (!flashes.length) return;
  await mkdir(ARCHIVE_DIR, { recursive: true });
  const file = path.join(ARCHIVE_DIR, `${new Date().toISOString().slice(0, 7)}.jsonl`);
  const lines = flashes.map((f) => JSON.stringify(f)).join("\n") + "\n";
  await appendFile(file, lines, "utf8");
}

/**
 * 本地档案关键词检索（“查某个币的新闻”）。poller 启动后的所有快讯都能查；
 * 更久远的历史要等官方 API Key 再走 /v1/search。
 */
export async function searchArchive(keyword: string, limit = 20): Promise<Flash[]> {
  const needle = keyword.toLowerCase();
  let files: string[];
  try {
    files = (await readdir(ARCHIVE_DIR)).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  } catch {
    return [];
  }
  const hits: Flash[] = [];
  for (const file of files) {
    const raw = await readFile(path.join(ARCHIVE_DIR, file), "utf8");
    for (const line of raw.split("\n").reverse()) {
      if (!line.trim()) continue;
      if (!line.toLowerCase().includes(needle)) continue;
      try {
        const flash = JSON.parse(line) as Flash;
        if (
          flash.title.toLowerCase().includes(needle) ||
          flash.content?.toLowerCase().includes(needle)
        ) {
          hits.push(flash);
          if (hits.length >= limit) return hits;
        }
      } catch {
        // skip corrupt line
      }
    }
  }
  return hits;
}
