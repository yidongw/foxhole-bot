import { loadEnv } from "../lib/env.js";
loadEnv();

import {
  fetchCategories,
  fetchHot,
  searchNews,
  onlyTwitter,
  type OpenNewsItem,
} from "../news/opennews.js";

/**
 * 6551 / OpenNews 信号探针。
 *
 *   npm run opennews                 # 免票：web3 分类近 24h 热点（推特+新闻）
 *   npm run opennews -- --cat=macro  # 换分类（macro / web3 …）
 *   npm run opennews -- --twitter    # 只看推特(meme)情绪信号
 *   npm run opennews -- --min=80     # 只看 AI 分 ≥80 的
 *   npm run opennews -- --cats       # 列出所有分类 key
 *   npm run opennews -- --signal=long   # 需 OPENNEWS_TOKEN：全量搜按方向过滤
 *   npm run opennews -- --coin=BTC      # 需 OPENNEWS_TOKEN：按标的搜
 */

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=", 2)[1];
}
function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

const SIG = (s?: string) =>
  s === "long" ? "📈多" : s === "short" ? "📉空" : s === "neutral" ? "· 中" : s ?? "?";

function line(it: OpenNewsItem): string {
  const score = it.score != null ? `[${it.score}${it.grade ? " " + it.grade : ""}]` : "[--]";
  const coins = it.coins?.length ? ` {${it.coins.slice(0, 6).join(",")}}` : "";
  const src = it.source ? ` (${it.source})` : "";
  const title = it.title.length > 140 ? it.title.slice(0, 140) + "…" : it.title;
  const link = it.link ? `\n     ${it.link}` : "";
  return `${score} ${SIG(it.signal)}${src}${coins}\n     ${title}${link}`;
}

function sortByScore(items: OpenNewsItem[]): OpenNewsItem[] {
  return [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

async function main(): Promise<void> {
  if (flag("tick")) {
    // run one watcher tick (posts high-score directional signals to #news-radar;
    // --dry prints only, no Discord)
    const { openNewsTick } = await import("../news/opennews-poll.js");
    const r = await openNewsTick({
      dryRun: flag("dry"),
      minScore: arg("min") ? Number(arg("min")) : undefined,
    });
    console.log(`opennews tick: ${r.fetched} scored, ${r.posted} posted`);
    return;
  }
  if (flag("cats")) {
    const cats = await fetchCategories();
    for (const c of cats) console.log(`${c.key.padEnd(12)} ${c.name_zh ?? ""} / ${c.name}`);
    return;
  }

  const min = arg("min") ? Number(arg("min")) : undefined;
  const signal = arg("signal");
  const coin = arg("coin");

  // 带票路径：全量搜索（按方向/标的/关键词过滤）
  if (signal || coin || arg("q")) {
    const items = await searchNews({
      coins: coin ? [coin] : undefined,
      query: arg("q"),
      score: min,
      limit: Number(arg("limit") ?? 30),
    });
    if (items === null) {
      console.error(
        "全量搜索需要 OPENNEWS_TOKEN（免费申请 https://6551.io/mcp），" +
          "然后在 .env 里设 OPENNEWS_TOKEN=…。当前只跑免票 --twitter/--cat 模式。",
      );
      process.exit(1);
    }
    let out = signal ? items.filter((it) => it.signal === signal) : items;
    out = sortByScore(out);
    console.log(`\n6551 全量搜索 · ${out.length} 条` + (signal ? ` · signal=${signal}` : "") + "\n");
    for (const it of out) console.log(line(it) + "\n");
    return;
  }

  // 免票路径：分类热点
  const cat = arg("cat") ?? "web3";
  let items = await fetchHot(cat);
  if (flag("twitter")) items = onlyTwitter(items);
  if (min != null) items = items.filter((it) => (it.score ?? 0) >= min);
  items = sortByScore(items);

  const label = flag("twitter") ? "推特(meme)情绪" : "热点";
  if (!items.length) {
    console.log(`6551 [${cat}] ${label}：暂无数据（可能正在生成，稍后再试）`);
    return;
  }
  console.log(`\n6551 [${cat}] ${label} · 近24h · ${items.length} 条 (按AI分排序)\n`);
  for (const it of items) console.log(line(it) + "\n");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
