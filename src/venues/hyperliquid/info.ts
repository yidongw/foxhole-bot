/**
 * Hyperliquid 只读行情 API (`/info`)。零依赖:纯 fetch + POST,无需签名。
 * paper 模式的定价/可交易性/持仓查询全走这里,不需要装任何 SDK。
 *
 * 文档: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
 */

const MAINNET_API = "https://api.hyperliquid.xyz";
const TESTNET_API = "https://api.hyperliquid-testnet.xyz";

export function hlApiBase(testnet: boolean): string {
  return testnet ? TESTNET_API : MAINNET_API;
}

async function infoPost<T>(testnet: boolean, body: unknown): Promise<T> {
  const res = await fetch(`${hlApiBase(testnet)}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HL /info ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** coin → mid price(字符串)。HIP-3 dex 传 dex 名。 */
export async function fetchAllMids(
  testnet: boolean,
  dex?: string,
): Promise<Record<string, string>> {
  const body = dex ? { type: "allMids", dex } : { type: "allMids" };
  return infoPost<Record<string, string>>(testnet, body);
}

/** 单个标的的 mid price;查不到返回 undefined。 */
export async function fetchMidPrice(
  testnet: boolean,
  symbol: string,
  dex?: string,
): Promise<number | undefined> {
  const mids = await fetchAllMids(testnet, dex);
  const raw = mids[symbol];
  const px = raw != null ? Number(raw) : NaN;
  return Number.isFinite(px) && px > 0 ? px : undefined;
}

export interface HlUniverseAsset {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
  isDelisted?: boolean;
}

export interface HlMeta {
  universe: HlUniverseAsset[];
}

/** 永续标的宇宙(名称、size 精度、最大杠杆)。用于校验可交易性 + size 取整。 */
export async function fetchMeta(testnet: boolean, dex?: string): Promise<HlMeta> {
  const body = dex ? { type: "meta", dex } : { type: "meta" };
  return infoPost<HlMeta>(testnet, body);
}

/** 某标的在宇宙中的元信息(含资产索引 index,下单必需)。 */
export interface HlAssetInfo extends HlUniverseAsset {
  /** universe 中的下标 = 下单时的 asset id。 */
  index: number;
}

export async function fetchAssetInfo(
  testnet: boolean,
  symbol: string,
  dex?: string,
): Promise<HlAssetInfo | undefined> {
  const meta = await fetchMeta(testnet, dex);
  const index = meta.universe.findIndex((a) => a.name === symbol);
  if (index < 0) return undefined;
  return { ...meta.universe[index], index };
}

/** 相对变化百分比;prev<=0 视为 0(无参照)。 */
export function pctChange(prev: number, now: number): number {
  return prev > 0 ? ((now - prev) / prev) * 100 : 0;
}

export interface HlAssetContext {
  symbol: string;
  markPx: number;
  prevDayPx: number;
  /** 当前小时资金费率(小数,如 0.0000125 = 0.00125%/时)。 */
  funding: number;
  openInterest: number;
  /** 24h 涨跌 %(由 markPx vs prevDayPx 推算)。 */
  dayChangePct: number;
}

interface RawAssetCtx {
  markPx?: string;
  prevDayPx?: string;
  funding?: string;
  openInterest?: string;
}

/**
 * 单个标的的行情上下文:现价 + 24h 涨跌 + 资金费率 + 未平仓量。
 * 决策 AI 判断"新闻是否已被 price in / 是否追高"要靠这个,而非单点价。
 */
export async function fetchAssetContext(
  testnet: boolean,
  symbol: string,
  dex?: string,
): Promise<HlAssetContext | undefined> {
  const body = dex
    ? { type: "metaAndAssetCtxs", dex }
    : { type: "metaAndAssetCtxs" };
  const [meta, ctxs] = await infoPost<[HlMeta, RawAssetCtx[]]>(testnet, body);
  const idx = meta.universe.findIndex((a) => a.name === symbol);
  if (idx < 0) return undefined;
  const c = ctxs[idx];
  if (!c) return undefined;
  const markPx = Number(c.markPx);
  const prevDayPx = Number(c.prevDayPx);
  if (!Number.isFinite(markPx) || markPx <= 0) return undefined;
  return {
    symbol,
    markPx,
    prevDayPx: Number.isFinite(prevDayPx) ? prevDayPx : 0,
    funding: Number(c.funding) || 0,
    openInterest: Number(c.openInterest) || 0,
    dayChangePct: pctChange(prevDayPx, markPx),
  };
}

export interface HlPerpDex {
  name: string;
  full_name?: string;
  deployer?: string;
}

/** perpDexs 列表:下标 0 是核心永续(null),builder 部署的 HIP-3 dex 在其后。 */
export async function fetchPerpDexs(
  testnet: boolean,
): Promise<(HlPerpDex | null)[]> {
  return infoPost<(HlPerpDex | null)[]>(testnet, { type: "perpDexs" });
}

/**
 * builder dex 在 perpDexs 数组里的下标 = HIP-3 asset id 编码用的 perp_dex_index。
 * 核心永续(dexName 空)返回 0。查不到抛错。
 */
export async function resolvePerpDexIndex(
  testnet: boolean,
  dexName: string,
): Promise<number> {
  if (!dexName) return 0;
  const dexs = await fetchPerpDexs(testnet);
  const idx = dexs.findIndex((d) => d?.name === dexName);
  if (idx < 0) throw new Error(`perp dex "${dexName}" 不在 perpDexs 列表内`);
  return idx;
}

/**
 * 一次性拉取所有标的的当前小时资金费率(symbol → hourlyRate,小数)。
 * managePerpPositions 每 tick 调一次即可给所有持仓计费,避免 per-仓网络调用。
 */
export async function fetchAllFundingRates(
  testnet: boolean,
  dex?: string,
): Promise<Record<string, number>> {
  const body = dex
    ? { type: "metaAndAssetCtxs", dex }
    : { type: "metaAndAssetCtxs" };
  const [meta, ctxs] = await infoPost<[HlMeta, RawAssetCtx[]]>(testnet, body);
  const out: Record<string, number> = {};
  meta.universe.forEach((a, i) => {
    const f = Number(ctxs[i]?.funding);
    if (Number.isFinite(f)) out[a.name] = f;
  });
  return out;
}

export interface HlAssetPosition {
  position: {
    coin: string;
    szi: string; // signed size(正=多,负=空)
    entryPx?: string;
    positionValue?: string;
    unrealizedPnl?: string;
    liquidationPx?: string;
    leverage?: { type: string; value: number };
  };
}

export interface HlClearinghouseState {
  assetPositions: HlAssetPosition[];
  marginSummary: {
    accountValue: string;
    totalMarginUsed: string;
  };
  withdrawable: string;
}

/** 账户实盘持仓/保证金状态(live 模式对账用)。 */
export async function fetchClearinghouseState(
  testnet: boolean,
  user: string,
  dex?: string,
): Promise<HlClearinghouseState> {
  const body = dex
    ? { type: "clearinghouseState", user, dex }
    : { type: "clearinghouseState", user };
  return infoPost<HlClearinghouseState>(testnet, body);
}
