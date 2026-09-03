/**
 * 币安 USDⓈ-M 永续 **公开** 数据客户端(无需 API key)。只读,用于 OI 异动策略。
 * 参考数据面(NewsLiquid 抓妖币用的就是这几路只有币安才公布的数据):
 *   - openInterestHist:未平仓合约(含 USD 名义值)时序
 *   - topLongShortPositionRatio:大户(主力)持仓多空比 —— "主力方向/占比" 的公开代理
 *   - ticker/24hr:24h 涨跌 + 成交额
 *
 * 文档: https://developers.binance.com/docs/derivatives/usds-margined-futures
 * 注:/futures/data/* 仅支持近 30 天,period ∈ {5m,15m,30m,1h,2h,4h,6h,12h,1d}。
 */

const FAPI_BASE = "https://fapi.binance.com";

async function fapiGet<T>(
  path: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string]),
  ).toString();
  const url = `${FAPI_BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Binance ${path} ${res.status}: ${text.slice(0, 160)}`);
  }
  return (await res.json()) as T;
}

export interface Ticker24h {
  symbol: string;
  priceChangePercent: number;
  lastPrice: number;
  quoteVolume: number;
}

interface RawTicker24h {
  symbol: string;
  priceChangePercent: string;
  lastPrice: string;
  quoteVolume: string;
}

/** 全市场 24h 行情(一次调用返回所有 symbol)。 */
export async function fetchAll24hTickers(): Promise<Ticker24h[]> {
  const raw = await fapiGet<RawTicker24h[]>("/fapi/v1/ticker/24hr");
  return raw.map((t) => ({
    symbol: t.symbol,
    priceChangePercent: Number(t.priceChangePercent),
    lastPrice: Number(t.lastPrice),
    quoteVolume: Number(t.quoteVolume),
  }));
}

export interface OiHistPoint {
  timestamp: number;
  /** 未平仓合约(币数)。 */
  sumOpenInterest: number;
  /** 未平仓合约 USD 名义值。 */
  sumOpenInterestValueUsd: number;
}

interface RawOiHist {
  timestamp: number;
  sumOpenInterest: string;
  sumOpenInterestValue: string;
}

/** 某标的的 OI 时序(升序)。period 如 "5m",limit≤500。 */
export async function fetchOpenInterestHist(
  symbol: string,
  period = "5m",
  limit = 4,
): Promise<OiHistPoint[]> {
  const raw = await fapiGet<RawOiHist[]>("/futures/data/openInterestHist", {
    symbol,
    period,
    limit,
  });
  return raw.map((p) => ({
    timestamp: p.timestamp,
    sumOpenInterest: Number(p.sumOpenInterest),
    sumOpenInterestValueUsd: Number(p.sumOpenInterestValue),
  }));
}

export interface TopTraderRatioPoint {
  timestamp: number;
  /** 大户多头持仓占比 (0..1)。 */
  longAccount: number;
  /** 大户空头持仓占比 (0..1)。 */
  shortAccount: number;
  /** 多空比 = long/short。 */
  longShortRatio: number;
}

interface RawTopTraderRatio {
  timestamp: number;
  longAccount: string;
  shortAccount: string;
  longShortRatio: string;
}

/**
 * 大户(主力)**持仓量**多空比。这是"主力方向/占比"最直接的公开代理:
 * longAccount 高 = 主力偏多。period 如 "5m"。
 */
export async function fetchTopLongShortPositionRatio(
  symbol: string,
  period = "5m",
  limit = 2,
): Promise<TopTraderRatioPoint[]> {
  const raw = await fapiGet<RawTopTraderRatio[]>(
    "/futures/data/topLongShortPositionRatio",
    { symbol, period, limit },
  );
  return raw.map((p) => ({
    timestamp: p.timestamp,
    longAccount: Number(p.longAccount),
    shortAccount: Number(p.shortAccount),
    longShortRatio: Number(p.longShortRatio),
  }));
}

export interface AccountRatioPoint {
  timestamp: number;
  longAccount: number;
  shortAccount: number;
  longShortRatio: number;
}

interface RawAccountRatio {
  timestamp: number;
  longAccount: string;
  shortAccount: string;
  longShortRatio: string;
}

/**
 * 全市场**账户数**多空比(散户为主的人数口径)。与大户持仓比对比 = 聪明钱 vs 散户背离。
 */
export async function fetchGlobalLongShortAccountRatio(
  symbol: string,
  period = "5m",
  limit = 1,
): Promise<AccountRatioPoint[]> {
  const raw = await fapiGet<RawAccountRatio[]>(
    "/futures/data/globalLongShortAccountRatio",
    { symbol, period, limit },
  );
  return raw.map((p) => ({
    timestamp: p.timestamp,
    longAccount: Number(p.longAccount),
    shortAccount: Number(p.shortAccount),
    longShortRatio: Number(p.longShortRatio),
  }));
}

export interface TakerRatioPoint {
  timestamp: number;
  /** taker 主动买占比 (0..1)。 */
  buyRatio: number;
  buySellRatio: number;
}

interface RawTakerRatio {
  timestamp: number;
  buySellRatio: string;
  buyVol: string;
  sellVol: string;
}

/** taker 主动买卖量比(主力市价买入的进攻性确认)。 */
export async function fetchTakerLongShortRatio(
  symbol: string,
  period = "5m",
  limit = 1,
): Promise<TakerRatioPoint[]> {
  const raw = await fapiGet<RawTakerRatio[]>(
    "/futures/data/takerlongshortRatio",
    { symbol, period, limit },
  );
  return raw.map((p) => {
    const buy = Number(p.buyVol);
    const sell = Number(p.sellVol);
    const total = buy + sell;
    return {
      timestamp: p.timestamp,
      buyRatio: total > 0 ? buy / total : 0.5,
      buySellRatio: Number(p.buySellRatio),
    };
  });
}

interface RawPremium {
  symbol: string;
  lastFundingRate: string;
}

/** 全市场资金费率(一次调用返回所有 symbol),symbol → 当期资金费率(小数)。 */
export async function fetchAllFundingRates(): Promise<Record<string, number>> {
  const raw = await fapiGet<RawPremium[]>("/fapi/v1/premiumIndex");
  const out: Record<string, number> = {};
  for (const p of raw) {
    const f = Number(p.lastFundingRate);
    if (Number.isFinite(f)) out[p.symbol] = f;
  }
  return out;
}

interface RawExchangeInfo {
  symbols: Array<{
    symbol: string;
    contractType: string;
    status: string;
    quoteAsset: string;
    baseAsset: string;
  }>;
}

/** 交易中的 USDT 本位永续 symbol 列表(如 BTCUSDT)。 */
export async function fetchPerpSymbols(): Promise<string[]> {
  const info = await fapiGet<RawExchangeInfo>("/fapi/v1/exchangeInfo");
  return info.symbols
    .filter(
      (s) =>
        s.contractType === "PERPETUAL" &&
        s.status === "TRADING" &&
        s.quoteAsset === "USDT",
    )
    .map((s) => s.symbol);
}

/** 币安永续 symbol → 基础币名(BTCUSDT → BTC),供映射到 HL/下单。 */
export function baseAsset(symbol: string): string {
  return symbol.replace(/USDT$/, "").replace(/USDC$/, "");
}
