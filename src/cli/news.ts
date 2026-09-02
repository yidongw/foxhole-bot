import { loadEnv } from "../lib/env.js";
loadEnv();

import {
  fetchNewFlashes,
  fetchLatestFlashId,
  searchArchive,
  searchNews,
} from "../news/blockbeats.js";
import { classifyFlash, extractSymbols, usableSymbols } from "../news/filter.js";
import { newsTick } from "../news/poll.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LaunchesPayload } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function watchedSymbols(): Promise<string[]> {
  try {
    const raw = await readFile(
      path.resolve(__dirname, "../../data/launches.json"),
      "utf8",
    );
    return usableSymbols(
      (JSON.parse(raw) as LaunchesPayload).launches.map((l) => l.symbol),
    );
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "search") {
    const keyword = rest.join(" ").trim();
    if (!keyword) {
      console.error("usage: npm run news:search -- <keyword>");
      process.exit(1);
    }
    const official = await searchNews(keyword, 15);
    if (official) {
      if (!official.length) console.log(`律动无 "${keyword}" 相关内容`);
      for (const h of official) {
        console.log(`[${h.type === 1 ? "快讯" : "文章"}] ${h.createTime}  ${h.title}`);
      }
      return;
    }
    const hits = await searchArchive(keyword);
    if (!hits.length) {
      console.log(
        `no local hits for "${keyword}" (set BLOCKBEATS_API_KEY for full official search)`,
      );
      return;
    }
    for (const h of hits) console.log(`${h.fetchedAt}  ${h.title}\n  ${h.url}`);
    return;
  }

  if (cmd === "tick") {
    const result = await newsTick({ dryRun: rest.includes("--dry-run") });
    console.log(`news tick: ${result.fetched} fetched, ${result.woke} woke, ${result.noted} noted`);
    return;
  }

  // default: fetch recent flashes and show how each one classifies (no Discord)
  const latest = await fetchLatestFlashId();
  if (!latest) {
    console.error("could not reach BlockBeats");
    process.exit(1);
  }
  const { flashes } = await fetchNewFlashes(latest - 15, 15);
  const watched = new Set(await watchedSymbols());
  for (const flash of flashes) {
    const cls = classifyFlash(flash.title, [...watched], flash.content);
    // 模拟 poller 的热点币记忆：wake 过的 symbol 让后续快讯直接命中
    if (cls.action === "wake") {
      for (const sym of extractSymbols(flash.title)) watched.add(sym);
    }
    const tag = cls.action === "wake" ? (cls.negative ? "⚠️ WAKE" : "📰 WAKE") : cls.action;
    console.log(`${tag.padEnd(8)} ${flash.title}  [${cls.reasons.join(",")}]`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
