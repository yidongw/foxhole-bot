/**
 * 6551 / OpenNews 数据源客户端（@cryptoxiao / 6551Team，opennews-mcp 的 TS 移植子集）。
 *
 * 聚合 85+ 源（Bloomberg/Reuters/CoinDesk + Twitter/X 情绪 + Hyperliquid 巨鲸 +
 * 上币公告 + AI 预测信号），每条带 AI 打分：score 0-100 / grade / signal(long|short|neutral)。
 *
 * 两层接口：
 *  - 免票（无鉴权）：GET /open/free_categories、GET /open/free_hot?category=…
 *    → 直接拿到近 24h 带 AI 打分的热点新闻+推文，够做轻量推特/情绪雷达。
 *  - 带票（Bearer OPENNEWS_TOKEN，去 https://6551.io/mcp 免费申请）：
 *    POST /open/news_search → 可按 coins / 关键词 / engineType / 最低分过滤全量。
 *
 * REST/WSS 端点与鉴权格式对齐官方开源仓库 6551Team/opennews-mcp。
 */

const API_BASE = process.env.OPENNEWS_API_BASE || "https://ai.6551.io";

function token(): string | undefined {
  return process.env.OPENNEWS_TOKEN || undefined;
}

/** 单条新闻/推文信号（免票 free_hot 与带票 news_search 归一化后的形态）。 */
export interface OpenNewsItem {
  id: number;
  title: string;
  /** 来源名：twitter / Bloomberg / Reuters / …（engine_type=meme 时多为 twitter）。 */
  source?: string;
  /** 引擎类别：news / listing | onchain | meme | market | prediction。 */
  engineType?: string;
  /** 原文链接（推特信号是 x.com/…）。 */
  link?: string;
  /** AI 影响力打分 0-100。 */
  score?: number;
  /** AI 评级 A+/A/B…。 */
  grade?: string;
  /** AI 交易方向：long(利多) / short(利空) / neutral。 */
  signal?: string;
  /** 关联标的（可能含 XYZ- 前缀的合成代号）。 */
  coins?: string[];
  summary?: string;
  publishedAt?: string;
}

interface FreeHotRaw {
  coins: string[] | null;
  created_at?: string;
  published_at?: string;
  engine_type?: string;
  grade?: string;
  id: number;
  link?: string;
  score?: number;
  signal?: string;
  source?: string;
  summary_en?: string;
  summary_zh?: string;
  title: string;
}

function normalizeFreeHot(r: FreeHotRaw): OpenNewsItem {
  return {
    id: r.id,
    title: r.title,
    source: r.source,
    engineType: r.engine_type,
    link: r.link || undefined,
    score: r.score,
    grade: r.grade,
    signal: r.signal,
    coins: r.coins ?? undefined,
    summary: r.summary_zh || r.summary_en || undefined,
    publishedAt: r.published_at || r.created_at,
  };
}

/** GET /open/free_categories — 免票，返回分类树（key: macro / web3 / …）。 */
export async function fetchCategories(): Promise<
  Array<{ key: string; name: string; name_zh?: string }>
> {
  const res = await fetch(`${API_BASE}/open/free_categories`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`free_categories HTTP ${res.status}`);
  const json = (await res.json()) as { categories?: Array<{ key: string; name: string; name_zh?: string }> };
  return json.categories ?? [];
}

/**
 * GET /open/free_hot — 免票，某分类近 24h 的 AI 打分热点（新闻+推特）。
 * category 用 fetchCategories() 的 key（macro / web3 …）。数据生成中时返回空数组。
 */
export async function fetchHot(category = "web3"): Promise<OpenNewsItem[]> {
  const url = `${API_BASE}/open/free_hot?category=${encodeURIComponent(category)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`free_hot HTTP ${res.status}`);
  const json = (await res.json()) as
    | { success?: false; message?: string }
    | { news?: { items?: FreeHotRaw[] } };
  if ((json as { success?: false }).success === false) return [];
  const items = (json as { news?: { items?: FreeHotRaw[] } }).news?.items ?? [];
  return items.map(normalizeFreeHot);
}

export interface SearchOpts {
  coins?: string[];
  query?: string;
  /** { news: ["Bloomberg"], meme: [], onchain: [] } 形式。 */
  engineTypes?: Record<string, string[]>;
  hasCoin?: boolean;
  /** 最低 AI 分（0-100）。 */
  score?: number;
  limit?: number;
  page?: number;
}

interface SearchRaw {
  id: number;
  title?: string;
  text?: string;
  description?: string;
  source?: string;
  engineType?: string;
  engine_type?: string;
  newsType?: string;
  link?: string;
  url?: string;
  coins?: Array<string | { s?: string; symbol?: string }>;
  publishedAt?: string;
  published_at?: string;
  ts?: string;
  aiRating?: { score?: number; grade?: string; signal?: string; status?: string; summary?: string; enSummary?: string };
  score?: number;
  grade?: string;
  signal?: string;
}

function coinSymbols(coins?: SearchRaw["coins"]): string[] | undefined {
  if (!coins?.length) return undefined;
  const out = coins
    .map((c) => (typeof c === "string" ? c : c.s ?? c.symbol))
    .filter((x): x is string => !!x);
  return out.length ? out : undefined;
}

function normalizeSearch(r: SearchRaw): OpenNewsItem {
  const ai = r.aiRating ?? {};
  const title = (r.title || r.text || r.description || "").replace(/\s+/g, " ").trim();
  return {
    id: r.id,
    title,
    source: r.source,
    engineType: r.engineType ?? r.engine_type ?? r.newsType,
    link: r.link || r.url || undefined,
    score: ai.score ?? r.score,
    grade: ai.grade ?? r.grade,
    signal: ai.signal ?? r.signal,
    coins: coinSymbols(r.coins),
    summary: ai.summary || ai.enSummary || undefined,
    publishedAt: r.publishedAt ?? r.published_at ?? r.ts,
  };
}

/**
 * POST /open/news_search — 需 OPENNEWS_TOKEN。全量搜索+过滤。
 * 未配 token 时返回 null（调用方回退到 fetchHot 免票层）。
 */
export async function searchNews(opts: SearchOpts = {}): Promise<OpenNewsItem[] | null> {
  const tok = token();
  if (!tok) return null;
  const body: Record<string, unknown> = {
    limit: opts.limit ?? 20,
    page: opts.page ?? 1,
  };
  if (opts.coins?.length) body.coins = opts.coins;
  if (opts.query) body.q = opts.query;
  if (opts.engineTypes) body.engineTypes = opts.engineTypes;
  if (opts.hasCoin) body.hasCoin = true;
  if (opts.score != null) body.score = opts.score;

  const res = await fetch(`${API_BASE}/open/news_search`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tok}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`news_search HTTP ${res.status}`);
  const json = (await res.json()) as { data?: SearchRaw[] };
  return (json.data ?? []).map(normalizeSearch);
}

/** 只留 engine_type=meme（推特情绪层）的信号。 */
export function onlyTwitter(items: OpenNewsItem[]): OpenNewsItem[] {
  return items.filter(
    (it) => it.engineType === "meme" || it.source?.toLowerCase() === "twitter",
  );
}
