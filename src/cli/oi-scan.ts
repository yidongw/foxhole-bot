#!/usr/bin/env node
import { loadEnv } from "../lib/env.js";
loadEnv();

import {
  candidateSides,
  evaluateOiAnomaly,
  loadOiThresholds,
  oiRisePct,
  reconstructWhaleCost,
  scanOiAnomalies,
  type OiMetrics,
} from "../signals/oi-anomaly.js";
import {
  baseAsset,
  fetchAll24hTickers,
  fetchAllFundingRates,
  fetchGlobalLongShortAccountRatio,
  fetchOpenInterestHist,
  fetchTakerLongShortRatio,
  fetchTopLongShortPositionRatio,
} from "../venues/binance/futures.js";
import { appendAiInboxPerp } from "../notify/ai-inbox.js";

/**
 * OI 异动扫描 CLI(币安公开数据 → 妖币启动信号)。
 *
 *   oi-scan                 扫一轮,打印命中(不投递)
 *   oi-scan --inbox         扫一轮并把命中投递到 AI 收件箱
 *   oi-scan <SYMBOL>        看单个 symbol 的全维指标与判定(调试,如 AKE 或 AKEUSDT)
 */

async function inspectOne(symbolArg: string): Promise<void> {
  const t = loadOiThresholds();
  const symbol = symbolArg.toUpperCase().endsWith("USDT")
    ? symbolArg.toUpperCase()
    : `${symbolArg.toUpperCase()}USDT`;
  const bars = Math.max(t.oiLookbackBars + 1, t.costWindowBars);
  const [oiHist, topRatio, global, taker, tickers, funding] = await Promise.all([
    fetchOpenInterestHist(symbol, t.period, bars),
    fetchTopLongShortPositionRatio(symbol, t.period, 1),
    fetchGlobalLongShortAccountRatio(symbol, t.period, 1).catch(() => []),
    fetchTakerLongShortRatio(symbol, t.period, 1).catch(() => []),
    fetchAll24hTickers(),
    fetchAllFundingRates().catch(() => ({}) as Record<string, number>),
  ]);
  const tk = tickers.find((x) => x.symbol === symbol);
  const metrics: OiMetrics = {
    symbol,
    base: baseAsset(symbol),
    lastPrice: tk?.lastPrice ?? 0,
    oiValueUsd: oiHist.at(-1)?.sumOpenInterestValueUsd ?? 0,
    oiRisePct: oiRisePct(oiHist, t.oiLookbackBars),
    topTraderLong: topRatio.at(-1)?.longAccount ?? 0,
    topTraderShort: topRatio.at(-1)?.shortAccount ?? 0,
    whaleCostBasis: reconstructWhaleCost(oiHist),
    priceChgPctWindow: tk?.priceChangePercent ?? 0,
    quoteVol24h: tk?.quoteVolume ?? 0,
    globalLong: global.at(-1)?.longAccount ?? 0.5,
    globalShort: global.at(-1)?.shortAccount ?? 0.5,
    takerBuyRatio: taker.at(-1)?.buyRatio ?? 0.5,
    fundingRate: funding[symbol] ?? 0,
  };
  const sides = candidateSides(metrics, { ...t, enableShort: true });
  console.log(`${symbol} (${metrics.base})  现价 $${metrics.lastPrice}`);
  for (const s of sides.length ? sides : (["long"] as const)) {
    const v = evaluateOiAnomaly(metrics, t, s);
    console.log(`  [${s}] ${v.hit ? "✅ 命中" : "✗ 未命中"} 分 ${v.score.toFixed(2)}`);
    for (const r of v.reasons) console.log(`      ${r}`);
  }
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const toInbox = args.includes("--inbox");
  const symbolArg = args.find((a) => !a.startsWith("--"));

  if (symbolArg) {
    await inspectOne(symbolArg);
    return;
  }

  const t = loadOiThresholds();
  const hits = await scanOiAnomalies(t);
  if (!hits.length) {
    console.log(
      `本轮无 OI 异动命中(候选 ${t.candidateCount};OI≥$${(t.minOiValueUsd / 1e6).toFixed(1)}M 涨≥${t.minOiRisePct}% 大户≥${(t.minTopTraderDir * 100).toFixed(0)}% 盈利≥${t.minWhaleProfitPct}%${t.enableShort ? " +做空" : ""})`,
    );
    return;
  }
  console.log(`OI 异动命中 ${hits.length} 个:`);
  for (const { metrics, verdict } of hits) {
    const arrow = verdict.side === "long" ? "🟢多" : "🔴空";
    console.log(
      `${arrow} ${metrics.base} 分${verdict.score.toFixed(2)} | ` +
        `OI $${(metrics.oiValueUsd / 1e6).toFixed(1)}M 涨${metrics.oiRisePct.toFixed(1)}% | ` +
        `大户多${(metrics.topTraderLong * 100).toFixed(0)}% | 主力成本$${metrics.whaleCostBasis.toPrecision(4)} 现$${metrics.lastPrice} | ` +
        `24h${metrics.priceChgPctWindow >= 0 ? "+" : ""}${metrics.priceChgPctWindow.toFixed(0)}% 资金费${(metrics.fundingRate * 100).toFixed(3)}%`,
    );
    if (toInbox) {
      await appendAiInboxPerp({
        source: "oi-anomaly",
        symbol: metrics.base,
        side: verdict.side,
        score: verdict.score,
        metrics: {
          oiValueUsd: metrics.oiValueUsd,
          oiRisePct: metrics.oiRisePct,
          topTraderLong: metrics.topTraderLong,
          whaleCostBasis: metrics.whaleCostBasis,
          lastPrice: metrics.lastPrice,
          priceChg24h: metrics.priceChgPctWindow,
          fundingRate: metrics.fundingRate,
        },
        reasons: verdict.reasons,
      });
    }
  }
  if (toInbox) console.log(`已投递 ${hits.length} 条到 AI 收件箱`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
