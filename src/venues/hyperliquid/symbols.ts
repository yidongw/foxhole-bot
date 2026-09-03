/**
 * 新闻词 → Hyperliquid 永续符号解析。
 *
 * 现货那条线是"从快讯里抽合约地址";永续这条线不同——新闻给的是"某某币 / 某公司",
 * 要映射成 HL 上的**交易符号**(BTC、HYPE、TSLA…),再校验该符号在宇宙里确实可交易。
 * 这就是把新闻信号接到永续执行层的桥。别名表按需扩,分析层你要自己调,这里只做解析。
 */

import type { HlConfig } from "./config.js";
import { fetchMeta } from "./info.js";

/** 常见全称/俗名 → HL 符号。key 一律小写。 */
const ALIASES: Record<string, string> = {
  // 主流币
  bitcoin: "BTC",
  btc: "BTC",
  ethereum: "ETH",
  eth: "ETH",
  ether: "ETH",
  solana: "SOL",
  sol: "SOL",
  hyperliquid: "HYPE",
  hype: "HYPE",
  ripple: "XRP",
  xrp: "XRP",
  bnb: "BNB",
  binancecoin: "BNB",
  cardano: "ADA",
  ada: "ADA",
  avalanche: "AVAX",
  avax: "AVAX",
  chainlink: "LINK",
  link: "LINK",
  // meme
  dogecoin: "DOGE",
  doge: "DOGE",
  shiba: "SHIB",
  shibainu: "SHIB",
  shib: "SHIB",
  pepe: "PEPE",
  bonk: "BONK",
  wif: "WIF",
  dogwifhat: "WIF",
  // HIP-3 美股(trade.xyz 等 builder 部署;符号名以 live dex 的 meta 为准)
  tesla: "TSLA",
  tsla: "TSLA",
  apple: "AAPL",
  aapl: "AAPL",
  nvidia: "NVDA",
  nvda: "NVDA",
  amazon: "AMZN",
  amzn: "AMZN",
  microsoft: "MSFT",
  msft: "MSFT",
  google: "GOOGL",
  alphabet: "GOOGL",
  meta: "META",
};

export function normalizeTerm(term: string): string {
  return term.trim().toLowerCase().replace(/[$#@]/g, "");
}

/**
 * 把一个自由文本词条解析成候选 HL 符号(不保证可交易——再用 isTradableOnHl 校验)。
 * 命中别名优先;否则看起来像 ticker(2-10 位字母数字)就原样大写透传;都不是则 undefined。
 */
export function resolveHlSymbol(term: string): string | undefined {
  const t = normalizeTerm(term);
  if (!t) return undefined;
  if (ALIASES[t]) return ALIASES[t];
  if (/^[a-z0-9]{2,10}$/.test(t)) return t.toUpperCase();
  return undefined;
}

/** 拉取当前可交易(未下架)的符号集合,带失败兜底。 */
export async function tradableSymbols(config: HlConfig): Promise<Set<string>> {
  const meta = await fetchMeta(config.testnet, config.dex || undefined);
  return new Set(
    meta.universe.filter((a) => !a.isDelisted).map((a) => a.name),
  );
}

export async function isTradableOnHl(
  symbol: string,
  config: HlConfig,
): Promise<boolean> {
  const set = await tradableSymbols(config);
  return set.has(symbol);
}

/**
 * 把请求词匹配成宇宙里**真实存在**的符号名(保留其原始大小写)。纯函数,可单测。
 * 顺序:精确 → 大小写不敏感 → 别名 → k 前缀 meme。
 *
 * 为什么要 k 前缀:HL 对高供应量 meme 用 "k" 前缀(kPEPE = 1000 PEPE,还有
 * kBONK/kSHIB/kFLOKI…)。新闻里的 "PEPE" 直接名不在宇宙,必须落到 kPEPE,否则
 * 整条 meme 做多/做空路径静默失效。且 k 是小写,任何强制大写都会破坏它。
 */
export function matchInUniverse(
  requested: string,
  universe: Set<string>,
): string | undefined {
  const req = requested.trim();
  if (!req) return undefined;
  if (universe.has(req)) return req;

  const lower = req.toLowerCase();
  for (const s of universe) if (s.toLowerCase() === lower) return s;

  const alias = resolveHlSymbol(req);
  if (alias) {
    if (universe.has(alias)) return alias;
    const aliasLower = alias.toLowerCase();
    for (const s of universe) if (s.toLowerCase() === aliasLower) return s;
    const kLower = `k${alias}`.toLowerCase();
    for (const s of universe) if (s.toLowerCase() === kLower) return s;
  }
  return undefined;
}

/** matchInUniverse 的联网版:先拉宇宙再匹配。 */
export async function matchUniverseSymbol(
  requested: string,
  config: HlConfig,
): Promise<string | undefined> {
  return matchInUniverse(requested, await tradableSymbols(config));
}
