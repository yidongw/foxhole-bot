/**
 * OI 异动策略 —— NewsLiquid "抓妖币/单机盘" 那套的公开数据实现。
 *
 * 原理:主力(大户)在一个币上建了主导性持仓、还在赚、且拿着没走 → 启动信号。
 * NewsLiquid 模板(币安永续):OI 值/涨幅 + 主力持仓占比 + 主力盈利率。
 *
 * V1(硬门,便宜、每候选都算):
 *   OI 名义值 ≥ 阈值 · OI 涨幅 ≥ 阈值 · 大户持仓偏向 ≥ 阈值 · 窗口价格顺方向 · 24h 成交额下限
 *   + 主力盈利率(V2 核心代理):OI 加权反推的主力成本 vs 现价
 * V2(软增强,仅对过硬门的候选拉,控速):
 *   聪明钱 vs 散户背离(大户持仓比 − 全市场账户比)· taker 主动买压 · 资金费极端过滤
 * 支持做多 / 做空镜像(OI_ENABLE_SHORT)。
 */

import {
  baseAsset,
  fetchAll24hTickers,
  fetchAllFundingRates,
  fetchGlobalLongShortAccountRatio,
  fetchOpenInterestHist,
  fetchTakerLongShortRatio,
  fetchTopLongShortPositionRatio,
  type OiHistPoint,
} from "../venues/binance/futures.js";

export type OiSide = "long" | "short";

export interface OiThresholds {
  minOiValueUsd: number;
  minOiRisePct: number;
  oiLookbackBars: number;
  /** 反推主力成本的回看根数(越长越平滑)。 */
  costWindowBars: number;
  /** 大户顺方向持仓占比下限 (0..1)。 */
  minTopTraderDir: number;
  /** 窗口价格顺方向幅度下限 (%,绝对值)。 */
  minPriceChgPct: number;
  /** 主力盈利率下限 (%,顺方向) —— NewsLiquid 第 3/4 条的公开代理。 */
  minWhaleProfitPct: number;
  minQuoteVol24h: number;
  candidateCount: number;
  period: string;
  // V2 软增强
  /** 资金费率绝对值上限,超过视为拥挤/成本高,过滤。 */
  maxFundingAbs: number;
  /** 聪明钱 vs 散户背离下限(0=不要求;>0 时作软门)。 */
  minDivergence: number;
  /** taker 主动买占比下限(做多;做空对称用卖占比)。0.5=不要求。 */
  minTakerDir: number;
  enableShort: boolean;
}

export interface OiMetrics {
  symbol: string;
  base: string;
  lastPrice: number;
  oiValueUsd: number;
  oiRisePct: number;
  topTraderLong: number;
  topTraderShort: number;
  /** OI 加权反推的主力平均成本。 */
  whaleCostBasis: number;
  priceChgPctWindow: number;
  quoteVol24h: number;
  // V2(未拉取时给中性默认)
  globalLong: number;
  globalShort: number;
  takerBuyRatio: number;
  fundingRate: number;
}

export interface OiVerdict {
  hit: boolean;
  side: OiSide;
  score: number;
  reasons: string[];
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadOiThresholds(): OiThresholds {
  return {
    minOiValueUsd: num("OI_MIN_VALUE_USD", 3_000_000),
    minOiRisePct: num("OI_MIN_RISE_PCT", 3),
    oiLookbackBars: Math.max(1, num("OI_LOOKBACK_BARS", 1)),
    costWindowBars: Math.max(2, num("OI_COST_WINDOW_BARS", 12)),
    minTopTraderDir: num("OI_MIN_TOPTRADER_LONG", 0.55),
    minPriceChgPct: num("OI_MIN_PRICE_CHG_PCT", 0),
    minWhaleProfitPct: num("OI_MIN_WHALE_PROFIT_PCT", 0),
    minQuoteVol24h: num("OI_MIN_QUOTE_VOL_24H", 20_000_000),
    candidateCount: Math.max(1, num("OI_CANDIDATE_COUNT", 25)),
    period: process.env.OI_PERIOD?.trim() || "5m",
    maxFundingAbs: num("OI_MAX_FUNDING_ABS", 0.02),
    minDivergence: num("OI_MIN_DIVERGENCE", 0),
    minTakerDir: num("OI_MIN_TAKER_DIR", 0.5),
    enableShort: process.env.OI_ENABLE_SHORT === "1",
  };
}

/** OI 涨幅 %:最新 vs lookback 根之前。数据不足/分母 0 返回 0。 */
export function oiRisePct(points: { sumOpenInterest: number }[], lookback: number): number {
  if (points.length < lookback + 1) return 0;
  const last = points[points.length - 1].sumOpenInterest;
  const prev = points[points.length - 1 - lookback].sumOpenInterest;
  if (!(prev > 0)) return 0;
  return ((last - prev) / prev) * 100;
}

/**
 * OI 加权反推主力平均成本:新增仓位(ΔOI>0)按当根均价(值/量)加权。
 * 这是 NewsLiquid "平均开仓价" 的公开代理(无逐账户数据时)。数据不足回退到末根均价。
 */
export function reconstructWhaleCost(points: OiHistPoint[]): number {
  let wSum = 0;
  let w = 0;
  for (let i = 1; i < points.length; i++) {
    const dOi = points[i].sumOpenInterest - points[i - 1].sumOpenInterest;
    if (dOi > 0 && points[i].sumOpenInterest > 0) {
      const px = points[i].sumOpenInterestValueUsd / points[i].sumOpenInterest;
      if (px > 0) {
        wSum += dOi * px;
        w += dOi;
      }
    }
  }
  if (w > 0) return wSum / w;
  const last = points[points.length - 1];
  return last && last.sumOpenInterest > 0
    ? last.sumOpenInterestValueUsd / last.sumOpenInterest
    : 0;
}

/** 主力盈利率 %(顺方向):多头 (现价-成本)/成本;空头 (成本-现价)/成本。 */
export function whaleProfitPct(costBasis: number, lastPrice: number, side: OiSide): number {
  if (!(costBasis > 0)) return 0;
  const raw = side === "long" ? (lastPrice - costBasis) / costBasis : (costBasis - lastPrice) / costBasis;
  return raw * 100;
}

/**
 * 对给定方向评估。硬门全过才 hit;软增强(背离/taker/资金费)计入分数,
 * 且当阈值 >0 时作软门。返回 0..1 强度分。
 */
export function evaluateOiAnomaly(m: OiMetrics, t: OiThresholds, side: OiSide): OiVerdict {
  const reasons: string[] = [];
  const topDir = side === "long" ? m.topTraderLong : m.topTraderShort;
  const priceDir = side === "long" ? m.priceChgPctWindow : -m.priceChgPctWindow;
  const profit = whaleProfitPct(m.whaleCostBasis, m.lastPrice, side);
  const globalDir = side === "long" ? m.globalLong : m.globalShort;
  const divergence = topDir - globalDir; // 大户顺方向 − 散户顺方向
  const takerDir = side === "long" ? m.takerBuyRatio : 1 - m.takerBuyRatio;

  const gates: boolean[] = [];
  const add = (ok: boolean, label: string) => {
    gates.push(ok);
    reasons.push(`${ok ? "✓" : "✗"} ${label}`);
  };

  add(m.oiValueUsd >= t.minOiValueUsd, `OI值 $${(m.oiValueUsd / 1e6).toFixed(2)}M/≥$${(t.minOiValueUsd / 1e6).toFixed(1)}M`);
  add(m.oiRisePct >= t.minOiRisePct, `OI涨 ${m.oiRisePct.toFixed(2)}%/≥${t.minOiRisePct}%`);
  add(topDir >= t.minTopTraderDir, `大户${side === "long" ? "多" : "空"} ${(topDir * 100).toFixed(1)}%/≥${(t.minTopTraderDir * 100).toFixed(0)}%`);
  add(priceDir >= t.minPriceChgPct, `价格顺向 ${priceDir >= 0 ? "+" : ""}${priceDir.toFixed(2)}%/≥${t.minPriceChgPct}%`);
  add(profit >= t.minWhaleProfitPct, `主力盈利率 ${profit >= 0 ? "+" : ""}${profit.toFixed(2)}%/≥${t.minWhaleProfitPct}% (成本$${m.whaleCostBasis.toPrecision(4)})`);
  add(m.quoteVol24h >= t.minQuoteVol24h, `24h额 $${(m.quoteVol24h / 1e6).toFixed(0)}M/≥$${(t.minQuoteVol24h / 1e6).toFixed(0)}M`);

  // 软门(阈值>0 才作硬性要求;否则仅展示/计分)
  if (t.maxFundingAbs > 0) {
    add(Math.abs(m.fundingRate) <= t.maxFundingAbs, `资金费 ${(m.fundingRate * 100).toFixed(4)}%/≤${(t.maxFundingAbs * 100).toFixed(2)}%`);
  }
  if (t.minDivergence > 0) {
    add(divergence >= t.minDivergence, `聪明钱背离 ${(divergence * 100).toFixed(1)}pt/≥${(t.minDivergence * 100).toFixed(0)}pt`);
  } else {
    reasons.push(`· 背离 ${(divergence * 100).toFixed(1)}pt`);
  }
  if (t.minTakerDir > 0.5) {
    add(takerDir >= t.minTakerDir, `taker${side === "long" ? "买" : "卖"} ${(takerDir * 100).toFixed(1)}%/≥${(t.minTakerDir * 100).toFixed(0)}%`);
  } else {
    reasons.push(`· taker${side === "long" ? "买" : "卖"} ${(takerDir * 100).toFixed(1)}%`);
  }

  const hit = gates.every(Boolean);
  const oiScore = Math.min(1, m.oiRisePct / (t.minOiRisePct * 3));
  const dirScore = Math.min(1, Math.max(0, (topDir - 0.5) / 0.3));
  const profitScore = Math.min(1, Math.max(0, profit / 10));
  const divScore = Math.min(1, Math.max(0, divergence / 0.2));
  const takerScore = Math.min(1, Math.max(0, (takerDir - 0.5) / 0.2));
  const score = Math.max(
    0,
    Math.min(1, 0.3 * oiScore + 0.25 * dirScore + 0.25 * profitScore + 0.1 * divScore + 0.1 * takerScore),
  );

  return { hit, side, score, reasons };
}

/** 依大户持仓方向选择要评估的方向(偏多试多,偏空且开启做空试空)。 */
export function candidateSides(m: OiMetrics, t: OiThresholds): OiSide[] {
  const sides: OiSide[] = [];
  if (m.topTraderLong >= 0.5) sides.push("long");
  if (t.enableShort && m.topTraderShort > 0.5) sides.push("short");
  return sides;
}

/**
 * 两阶段联网扫描:
 *   阶段1(便宜,每候选):OI 时序 + 大户持仓比 → 硬门评估。
 *   阶段2(仅过硬门者):散户比 + taker + 资金费 → 软增强重评。
 * 单币失败跳过。返回命中(按分降序)。
 */
export async function scanOiAnomalies(
  t: OiThresholds = loadOiThresholds(),
): Promise<Array<{ metrics: OiMetrics; verdict: OiVerdict }>> {
  const [tickers, funding] = await Promise.all([
    fetchAll24hTickers(),
    fetchAllFundingRates().catch(() => ({}) as Record<string, number>),
  ]);
  const candidates = tickers
    .filter((x) => x.symbol.endsWith("USDT") && x.quoteVolume >= t.minQuoteVol24h)
    .sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent))
    .slice(0, t.candidateCount);

  const bars = Math.max(t.oiLookbackBars + 1, t.costWindowBars);
  const hits: Array<{ metrics: OiMetrics; verdict: OiVerdict }> = [];

  for (const c of candidates) {
    try {
      const [oiHist, topRatio] = await Promise.all([
        fetchOpenInterestHist(c.symbol, t.period, bars),
        fetchTopLongShortPositionRatio(c.symbol, t.period, 1),
      ]);
      if (!oiHist.length || !topRatio.length) continue;

      const metrics: OiMetrics = {
        symbol: c.symbol,
        base: baseAsset(c.symbol),
        lastPrice: c.lastPrice,
        oiValueUsd: oiHist[oiHist.length - 1].sumOpenInterestValueUsd,
        oiRisePct: oiRisePct(oiHist, t.oiLookbackBars),
        topTraderLong: topRatio[topRatio.length - 1].longAccount,
        topTraderShort: topRatio[topRatio.length - 1].shortAccount,
        whaleCostBasis: reconstructWhaleCost(oiHist),
        priceChgPctWindow: c.priceChangePercent,
        quoteVol24h: c.quoteVolume,
        globalLong: 0.5,
        globalShort: 0.5,
        takerBuyRatio: 0.5,
        fundingRate: funding[c.symbol] ?? 0,
      };

      // 阶段1:任一方向过硬门(不含软增强)才值得拉阶段2数据。
      const sides = candidateSides(metrics, t);
      const prePass = sides.some((s) => evaluateOiAnomaly(metrics, t, s).hit);
      if (!prePass) continue;

      // 阶段2:补软增强数据后重评。
      try {
        const [globalRatio, taker] = await Promise.all([
          fetchGlobalLongShortAccountRatio(c.symbol, t.period, 1),
          fetchTakerLongShortRatio(c.symbol, t.period, 1),
        ]);
        if (globalRatio.length) {
          metrics.globalLong = globalRatio[globalRatio.length - 1].longAccount;
          metrics.globalShort = globalRatio[globalRatio.length - 1].shortAccount;
        }
        if (taker.length) metrics.takerBuyRatio = taker[taker.length - 1].buyRatio;
      } catch {
        // 软数据拉取失败不致命,用中性默认继续。
      }

      let best: OiVerdict | undefined;
      for (const s of sides) {
        const v = evaluateOiAnomaly(metrics, t, s);
        if (v.hit && (!best || v.score > best.score)) best = v;
      }
      if (best) hits.push({ metrics, verdict: best });
    } catch {
      continue;
    }
  }
  hits.sort((a, b) => b.verdict.score - a.verdict.score);
  return hits;
}
