import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = path.resolve(__dirname, "../../data/news");

const LIST_URL = "https://www.theblockbeats.info/newsflash";
const FLASH_URL = (id: number) => `https://www.theblockbeats.info/flash/${id}`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

/**
 * BlockBeats（区块律动）快讯抓取。
 *
 * 官方开放 API 已改版为 API-Key 制（免费 Key 可申请，订阅提额）：
 * https://www.theblockbeats.info/apiDoc — 拿到 BLOCKBEATS_API_KEY 后应切到
 * 官方 open-flash / search 接口。在那之前走 SSR 页面：快讯 ID 严格递增，
 * 列表页取最新 ID，再逐条抓详情页的 <title>/og:description。
 */
export interface Flash {
  id: number;
  title: string;
  content?: string;
  url: string;
  fetchedAt: string;
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
