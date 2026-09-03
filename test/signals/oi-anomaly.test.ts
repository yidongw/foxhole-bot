import { describe, expect, it } from "vitest";

import {
  candidateSides,
  evaluateOiAnomaly,
  oiRisePct,
  reconstructWhaleCost,
  whaleProfitPct,
  type OiMetrics,
  type OiThresholds,
} from "../../src/signals/oi-anomaly.js";
import { baseAsset } from "../../src/venues/binance/futures.js";

const T: OiThresholds = {
  minOiValueUsd: 3_000_000,
  minOiRisePct: 3,
  oiLookbackBars: 1,
  costWindowBars: 12,
  minTopTraderDir: 0.55,
  minPriceChgPct: 0,
  minWhaleProfitPct: 0,
  minQuoteVol24h: 20_000_000,
  candidateCount: 25,
  period: "5m",
  maxFundingAbs: 0.02,
  minDivergence: 0,
  minTakerDir: 0.5,
  enableShort: false,
};

function metrics(over: Partial<OiMetrics> = {}): OiMetrics {
  return {
    symbol: "AKEUSDT",
    base: "AKE",
    lastPrice: 0.026,
    oiValueUsd: 34_000_000,
    oiRisePct: 4.65,
    topTraderLong: 0.6,
    topTraderShort: 0.4,
    whaleCostBasis: 0.0106,
    priceChgPctWindow: 199,
    quoteVol24h: 760_000_000,
    globalLong: 0.5,
    globalShort: 0.5,
    takerBuyRatio: 0.55,
    fundingRate: 0.0005,
    ...over,
  };
}

describe("oiRisePct", () => {
  it("最新 vs lookback 根之前", () => {
    expect(oiRisePct([{ sumOpenInterest: 100 }, { sumOpenInterest: 105 }], 1)).toBeCloseTo(5);
    expect(oiRisePct([{ sumOpenInterest: 100 }, { sumOpenInterest: 90 }], 1)).toBeCloseTo(-10);
  });
  it("数据不足/分母 0 返回 0", () => {
    expect(oiRisePct([{ sumOpenInterest: 100 }], 1)).toBe(0);
    expect(oiRisePct([{ sumOpenInterest: 0 }, { sumOpenInterest: 5 }], 1)).toBe(0);
  });
});

describe("reconstructWhaleCost — OI 加权成本反推", () => {
  it("按新增仓位加权(ΔOI>0 用当根均价 值/量)", () => {
    // bar0: 100币@$1(值100);bar1: +100币,值 300 → 该根均价 300/200=1.5,ΔOI=100
    // bar2: +100币,值 600 → 均价 600/300=2,ΔOI=100
    // 加权成本 = (100*1.5 + 100*2)/200 = 1.75
    const cost = reconstructWhaleCost([
      { timestamp: 0, sumOpenInterest: 100, sumOpenInterestValueUsd: 100 },
      { timestamp: 1, sumOpenInterest: 200, sumOpenInterestValueUsd: 300 },
      { timestamp: 2, sumOpenInterest: 300, sumOpenInterestValueUsd: 600 },
    ]);
    expect(cost).toBeCloseTo(1.75);
  });
  it("无新增仓位则回退末根均价", () => {
    const cost = reconstructWhaleCost([
      { timestamp: 0, sumOpenInterest: 200, sumOpenInterestValueUsd: 400 },
      { timestamp: 1, sumOpenInterest: 100, sumOpenInterestValueUsd: 300 },
    ]);
    expect(cost).toBeCloseTo(3); // 300/100
  });
});

describe("whaleProfitPct — 方向感知", () => {
  it("多头现价高于成本为盈利", () => {
    expect(whaleProfitPct(100, 120, "long")).toBeCloseTo(20);
    expect(whaleProfitPct(100, 120, "short")).toBeCloseTo(-20);
  });
  it("空头现价低于成本为盈利", () => {
    expect(whaleProfitPct(100, 80, "short")).toBeCloseTo(20);
  });
  it("成本非正返回 0", () => {
    expect(whaleProfitPct(0, 80, "long")).toBe(0);
  });
});

describe("evaluateOiAnomaly — 硬门", () => {
  it("AKE 式全过 → 命中做多", () => {
    const v = evaluateOiAnomaly(metrics(), T, "long");
    expect(v.hit).toBe(true);
    expect(v.side).toBe("long");
    expect(v.score).toBeGreaterThan(0);
  });
  it("OI 值不足 → 不命中", () => {
    expect(evaluateOiAnomaly(metrics({ oiValueUsd: 1e6 }), T, "long").hit).toBe(false);
  });
  it("OI 涨幅不足 → 不命中", () => {
    expect(evaluateOiAnomaly(metrics({ oiRisePct: 1 }), T, "long").hit).toBe(false);
  });
  it("大户不够偏多 → 不命中", () => {
    expect(evaluateOiAnomaly(metrics({ topTraderLong: 0.5 }), T, "long").hit).toBe(false);
  });
  it("主力已亏损(现价跌破成本)→ 不命中(盈利率门)", () => {
    const v = evaluateOiAnomaly(
      metrics({ whaleCostBasis: 0.05, lastPrice: 0.026 }),
      { ...T, minWhaleProfitPct: 0 },
      "long",
    );
    expect(v.hit).toBe(false);
  });
  it("资金费极端 → 不命中(拥挤过滤)", () => {
    expect(evaluateOiAnomaly(metrics({ fundingRate: 0.05 }), T, "long").hit).toBe(false);
  });
  it("背离软门开启且不足 → 不命中", () => {
    const v = evaluateOiAnomaly(
      metrics({ topTraderLong: 0.6, globalLong: 0.58 }),
      { ...T, minDivergence: 0.1 },
      "long",
    );
    expect(v.hit).toBe(false);
  });
});

describe("evaluateOiAnomaly — 做空镜像", () => {
  it("主力偏空 + 价跌 + 空头盈利 → 命中做空", () => {
    const m = metrics({
      topTraderLong: 0.35,
      topTraderShort: 0.65,
      priceChgPctWindow: -30,
      whaleCostBasis: 0.05,
      lastPrice: 0.026,
    });
    const v = evaluateOiAnomaly(m, T, "short");
    expect(v.hit).toBe(true);
    expect(v.side).toBe("short");
  });
});

describe("candidateSides", () => {
  it("偏多只试多;开启做空且偏空才试空", () => {
    expect(candidateSides(metrics({ topTraderLong: 0.6, topTraderShort: 0.4 }), T)).toEqual(["long"]);
    const short = candidateSides(
      metrics({ topTraderLong: 0.4, topTraderShort: 0.6 }),
      { ...T, enableShort: true },
    );
    expect(short).toContain("short");
  });
});

describe("baseAsset", () => {
  it("剥离 USDT/USDC 后缀", () => {
    expect(baseAsset("AKEUSDT")).toBe("AKE");
    expect(baseAsset("1000PEPEUSDT")).toBe("1000PEPE");
    expect(baseAsset("BTCUSDC")).toBe("BTC");
  });
});
