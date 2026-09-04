import { describe, expect, it } from "vitest";

import { loadHlConfig, type HlConfig } from "../../../src/venues/hyperliquid/config.js";
import { evaluatePerpExits } from "../../../src/venues/hyperliquid/engine.js";
import {
  accountPnlUsd,
  estimateLiquidationPrice,
  fundingAccrualUsd,
  isDailyReportDue,
  notionalSince,
  remainingFraction,
  shouldWarnLiquidation,
  totalPnlUsd,
  unrealizedPnlUsd,
  type PerpPosition,
  type PerpPositionsFile,
} from "../../../src/venues/hyperliquid/positions.js";
import {
  resolveHlSymbol,
  matchInUniverse,
} from "../../../src/venues/hyperliquid/symbols.js";
import { pctChange } from "../../../src/venues/hyperliquid/info.js";
import { checkPerpEntry } from "../../../src/venues/hyperliquid/risk.js";
import { encodeAssetId } from "../../../src/venues/hyperliquid/client.js";

const CONFIG: HlConfig = {
  ...loadHlConfig(),
  mode: "paper",
  hardStopPct: 0.15,
  trailStopPct: 0.1,
  maxHoldHours: 72,
  takeProfits: [
    { atPricePct: 10, closeFraction: 0.5 },
    { atPricePct: 25, closeFraction: 0.25 },
  ],
};

function longPos(over: Partial<PerpPosition> = {}): PerpPosition {
  return {
    id: "BTC-long-1",
    mode: "paper",
    venue: "hyperliquid",
    symbol: "BTC",
    side: "long",
    leverage: 3,
    openedAt: new Date().toISOString(),
    entryPriceUsd: 100,
    sizeUsd: 300,
    sizeCoins: 3,
    marginUsd: 100,
    bestPriceUsd: 100,
    exits: [],
    status: "open",
    ...over,
  };
}

describe("evaluatePerpExits — 方向感知", () => {
  it("多头逆向跌破硬止损 → 全平", () => {
    const p = longPos();
    const actions = evaluatePerpExits(p, 84, CONFIG); // -16% < -15%
    expect(actions[0]?.full).toBe(true);
    expect(actions[0]?.fraction).toBeCloseTo(1);
    expect(actions[0]?.reason).toContain("硬止损");
  });

  it("空头逆向涨破硬止损 → 全平", () => {
    const p = longPos({ side: "short", bestPriceUsd: 100 });
    const actions = evaluatePerpExits(p, 116, CONFIG); // +16% 逆向
    expect(actions[0]?.reason).toContain("硬止损");
  });

  it("多头 +12% 触发第一档止盈,平 50%", () => {
    const p = longPos({ bestPriceUsd: 112 });
    const actions = evaluatePerpExits(p, 112, CONFIG);
    expect(actions[0]?.full).toBe(false);
    expect(actions[0]?.fraction).toBeCloseTo(0.5);
    expect(actions[0]?.reason).toContain("止盈");
  });

  it("止盈幂等:已止盈 50% 后同价位不再重复触发", () => {
    const p = longPos({
      bestPriceUsd: 112,
      exits: [
        {
          at: new Date().toISOString(),
          markPriceUsd: 112,
          fraction: 0.5,
          realizedPnlUsd: 18,
          reason: "止盈 +12.0%",
        },
      ],
    });
    const actions = evaluatePerpExits(p, 112, CONFIG);
    expect(actions).toHaveLength(0);
  });

  it("多头从最高回撤触发移动止损", () => {
    const p = longPos({ bestPriceUsd: 130 });
    const actions = evaluatePerpExits(p, 116, CONFIG); // 从 130 回撤 ~10.8%
    expect(actions[0]?.reason).toContain("移动止损");
  });
});

describe("perp 仓位数学", () => {
  it("空头盈亏方向正确", () => {
    const p = longPos({ side: "short", entryPriceUsd: 100, sizeCoins: 2 });
    expect(unrealizedPnlUsd(p, 90)).toBeCloseTo(20); // 跌 10 × 2 枚
    expect(unrealizedPnlUsd(p, 110)).toBeCloseTo(-20);
  });

  it("部分平仓后剩余比例与总盈亏", () => {
    const p = longPos({
      exits: [
        {
          at: new Date().toISOString(),
          markPriceUsd: 120,
          fraction: 0.5,
          realizedPnlUsd: 30,
          reason: "止盈",
        },
      ],
    });
    expect(remainingFraction(p)).toBeCloseTo(0.5);
    // 剩 50%(1.5 枚)在 110:未实现 15 + 已实现 30 = 45
    expect(totalPnlUsd(p, 110)).toBeCloseTo(45);
  });

  it("刚开仓价格没动 → 账户盈亏 0(保证金不从权益扣)", () => {
    const now = new Date().toISOString();
    const file: PerpPositionsFile = {
      version: 1,
      positions: [
        longPos({ symbol: "BTC", entryPriceUsd: 100, sizeCoins: 3, openedAt: now }),
        longPos({ symbol: "ETH", side: "short", entryPriceUsd: 50, sizeCoins: 2, openedAt: now }),
      ],
    };
    // 现价 = 开仓价,零波动
    expect(accountPnlUsd(file, { BTC: 100, ETH: 50 })).toBeCloseTo(0);
  });

  it("已实现 + 未实现合并到账户盈亏", () => {
    const now = new Date().toISOString();
    const file: PerpPositionsFile = {
      version: 1,
      positions: [
        // 多头 BTC 3 枚 @100,现价 110 → 未实现 +30
        longPos({ symbol: "BTC", entryPriceUsd: 100, sizeCoins: 3 }),
        // 已平仓,已实现 +25
        longPos({
          symbol: "SOL",
          status: "closed",
          exits: [
            { at: now, markPriceUsd: 0, fraction: 1, realizedPnlUsd: 25, reason: "止盈" },
          ],
        }),
      ],
    };
    expect(accountPnlUsd(file, { BTC: 110 })).toBeCloseTo(55);
  });

  it("资金费:多头 rate>0 付出、空头收到,含入总盈亏", () => {
    const hour = 3_600_000;
    // notional 1000, rate 0.01%/时, 1 小时 → 量级 0.1
    expect(fundingAccrualUsd(1000, "long", 0.0001, hour)).toBeCloseTo(-0.1);
    expect(fundingAccrualUsd(1000, "short", 0.0001, hour)).toBeCloseTo(0.1);
    // rate<0 反向
    expect(fundingAccrualUsd(1000, "long", -0.0001, hour)).toBeCloseTo(0.1);
    // 边界:0 时长/非法率/0 名义 → 0
    expect(fundingAccrualUsd(1000, "long", 0.0001, 0)).toBe(0);
    expect(fundingAccrualUsd(0, "long", 0.0001, hour)).toBe(0);
    expect(fundingAccrualUsd(1000, "long", NaN, hour)).toBe(0);
  });

  it("totalPnlUsd 计入 fundingPnlUsd", () => {
    const p = longPos({ entryPriceUsd: 100, sizeCoins: 3, fundingPnlUsd: -0.5 });
    // 现价 110:未实现 +30,资金费 -0.5 → 29.5
    expect(totalPnlUsd(p, 110)).toBeCloseTo(29.5);
  });

  it("24h 名义敞口按剩余比例折算", () => {
    const now = new Date();
    const file: PerpPositionsFile = {
      version: 1,
      positions: [
        longPos({ sizeUsd: 300, openedAt: now.toISOString() }),
        longPos({
          sizeUsd: 300,
          openedAt: now.toISOString(),
          exits: [
            {
              at: now.toISOString(),
              markPriceUsd: 100,
              fraction: 0.5,
              realizedPnlUsd: 0,
              reason: "止盈",
            },
          ],
        }),
      ],
    };
    const since = new Date(now.getTime() - 3600_000).toISOString();
    expect(notionalSince(file, since)).toBeCloseTo(450); // 300 + 150
  });
});

describe("checkPerpEntry — 硬止损须早于强平", () => {
  const emptyFile: PerpPositionsFile = { version: 1, positions: [] };
  const base = { ...CONFIG, mode: "paper" as const, usdPerTrade: 50, maxLeverage: 20, maxOpenPerps: 3, maxDailyNotionalUsd: 0 };

  it("默认 15% 止损 + 3x 通过(强平距 33%)", () => {
    const v = checkPerpEntry(base, emptyFile, { symbol: "BTC", side: "long", sizeUsd: 50, leverage: 3 });
    expect(v.ok).toBe(true);
  });

  it("15% 止损 + 5x 通过(强平距 20%,留有缓冲)", () => {
    const v = checkPerpEntry(base, emptyFile, { symbol: "BTC", side: "long", sizeUsd: 50, leverage: 5 });
    expect(v.ok).toBe(true);
  });

  it("15% 止损 + 7x 拒绝(强平距≈14% < 止损,会先爆仓)", () => {
    const v = checkPerpEntry(base, emptyFile, { symbol: "BTC", side: "long", sizeUsd: 50, leverage: 7 });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("强平");
  });

  it("维持保证金率收紧强平距:低 maxLev meme 上 4x 被拒(与旧 1/杠杆 模型不同)", () => {
    // maxLev 5 → mmf 0.1;4x 真实强平距 = 1/4 - 0.1 = 0.15,止损 0.15 与之重合 → 拒绝
    const withMmf = checkPerpEntry(base, emptyFile, {
      symbol: "PEPE", side: "long", sizeUsd: 50, leverage: 4, maintenanceMarginFraction: 0.1,
    });
    expect(withMmf.ok).toBe(false);
    // 不传 mmf(旧模型 1/4=0.25)则会放行 —— 证明修复确实收紧了
    const withoutMmf = checkPerpEntry(base, emptyFile, {
      symbol: "PEPE", side: "long", sizeUsd: 50, leverage: 4,
    });
    expect(withoutMmf.ok).toBe(true);
  });
});

describe("checkPerpEntry — 其余守钱闸口", () => {
  const cfg = {
    ...CONFIG,
    mode: "paper" as const,
    usdPerTrade: 50,
    maxLeverage: 20,
    maxOpenPerps: 3,
    maxDailyNotionalUsd: 0,
    hardStopPct: 0.15,
  };
  const empty: PerpPositionsFile = { version: 1, positions: [] };

  it("合法开仓通过", () => {
    expect(
      checkPerpEntry(cfg, empty, { symbol: "BTC", side: "long", sizeUsd: 50, leverage: 3 }).ok,
    ).toBe(true);
  });

  it("usdPerTrade <= 0 不限单笔;paper 现金对保证金兜底", () => {
    const free = { ...cfg, usdPerTrade: 0 };
    // 名义 $2000 / 3x → 保证金 ~$667 < 起始现金 $1000: 放行(旧 $50 上限已拆)
    expect(
      checkPerpEntry(free, empty, { symbol: "BTC", side: "long", sizeUsd: 2000, leverage: 3 }).ok,
    ).toBe(true);
    // 名义 $5000 / 3x → 保证金 ~$1667 > 现金 $1000: 唯一保留的账本边界
    const v = checkPerpEntry(free, empty, { symbol: "BTC", side: "long", sizeUsd: 5000, leverage: 3 });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("现金");
  });

  it("HL_MODE=off 拒绝", () => {
    const v = checkPerpEntry({ ...cfg, mode: "off" }, empty, { symbol: "BTC", side: "long", sizeUsd: 50, leverage: 3 });
    expect(v.ok).toBe(false);
  });

  it("名义敞口超单笔上限拒绝", () => {
    const v = checkPerpEntry(cfg, empty, { symbol: "BTC", side: "long", sizeUsd: 60, leverage: 3 });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("单笔上限");
  });

  it("非法方向拒绝", () => {
    const v = checkPerpEntry(cfg, empty, { symbol: "BTC", side: "flat" as never, sizeUsd: 50, leverage: 3 });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("方向");
  });

  it("重复持仓拒绝", () => {
    const file: PerpPositionsFile = { version: 1, positions: [longPos({ symbol: "BTC" })] };
    const v = checkPerpEntry(cfg, file, { symbol: "BTC", side: "long", sizeUsd: 50, leverage: 3 });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("已有持仓");
  });

  it("超最大持仓数拒绝", () => {
    const file: PerpPositionsFile = {
      version: 1,
      positions: [longPos({ symbol: "ETH" }), longPos({ symbol: "SOL" })],
    };
    const v = checkPerpEntry({ ...cfg, maxOpenPerps: 2 }, file, { symbol: "BTC", side: "long", sizeUsd: 50, leverage: 3 });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("最大持仓数");
  });

  it("24h 名义敞口超限拒绝", () => {
    const file: PerpPositionsFile = {
      version: 1,
      positions: [longPos({ symbol: "ETH", sizeUsd: 80, openedAt: new Date().toISOString() })],
    };
    const v = checkPerpEntry({ ...cfg, maxDailyNotionalUsd: 100 }, file, { symbol: "BTC", side: "long", sizeUsd: 50, leverage: 3 });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("24h");
  });

  it("敞口上限 <=0 时关闭该限制", () => {
    const file: PerpPositionsFile = {
      version: 1,
      positions: [longPos({ symbol: "ETH", sizeUsd: 5000, openedAt: new Date().toISOString() })],
    };
    const v = checkPerpEntry({ ...cfg, maxDailyNotionalUsd: 0 }, file, { symbol: "BTC", side: "long", sizeUsd: 50, leverage: 3 });
    expect(v.ok).toBe(true);
  });
});

describe("estimateLiquidationPrice — 含维持保证金", () => {
  it("默认 mmf=0 保持旧行为(权益归零点)", () => {
    expect(estimateLiquidationPrice("long", 100, 5)).toBeCloseTo(80); // 100×(1-1/5)
    expect(estimateLiquidationPrice("short", 100, 5)).toBeCloseTo(120);
  });
  it("含维持保证金 → 强平价更靠近入场(预警更早)", () => {
    // maxLev 5 → mmf 0.1;3x 多头逆向幅度 = 1/3 - 0.1 = 0.2333 → liq ≈ 76.67
    const liq = estimateLiquidationPrice("long", 100, 3, 0.1);
    expect(liq).toBeCloseTo(76.67, 1);
    // 比不含维持保证金(66.67)更靠近入场价
    expect(liq).toBeGreaterThan(estimateLiquidationPrice("long", 100, 3));
  });
  it("逆向幅度不为负(mmf 过大时夹到 0)", () => {
    expect(estimateLiquidationPrice("long", 100, 2, 0.9)).toBeCloseTo(100);
  });
});

describe("isDailyReportDue", () => {
  const now = new Date("2026-09-03T12:00:00Z");
  it("无持仓不播报", () => {
    expect(isDailyReportDue(undefined, false, now)).toBe(false);
  });
  it("有持仓且从未播报 → 播报", () => {
    expect(isDailyReportDue(undefined, true, now)).toBe(true);
  });
  it("距上次不足 24h 不播报", () => {
    const recent = new Date(now.getTime() - 3 * 3600_000).toISOString();
    expect(isDailyReportDue(recent, true, now)).toBe(false);
  });
  it("距上次超过 24h 播报", () => {
    const old = new Date(now.getTime() - 25 * 3600_000).toISOString();
    expect(isDailyReportDue(old, true, now)).toBe(true);
  });
});

describe("pctChange", () => {
  it("正常涨跌", () => {
    expect(pctChange(100, 110)).toBeCloseTo(10);
    expect(pctChange(100, 90)).toBeCloseTo(-10);
  });
  it("无参照(prev<=0)返回 0,不产生 NaN/Infinity", () => {
    expect(pctChange(0, 110)).toBe(0);
    expect(pctChange(-5, 110)).toBe(0);
  });
});

describe("shouldWarnLiquidation — 节流", () => {
  const now = new Date("2026-09-03T12:00:00Z");

  it("距强平 >= 20% 不预警", () => {
    expect(shouldWarnLiquidation(100, 70, undefined, now)).toBe(false); // 距 30%
  });

  it("距强平 < 20% 且从未预警过 → 预警", () => {
    expect(shouldWarnLiquidation(100, 85, undefined, now)).toBe(true); // 距 15%
  });

  it("冷却期内(30min)不重复预警", () => {
    const recent = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect(shouldWarnLiquidation(100, 85, recent, now)).toBe(false);
  });

  it("超过冷却期可再次预警", () => {
    const old = new Date(now.getTime() - 40 * 60_000).toISOString();
    expect(shouldWarnLiquidation(100, 85, old, now)).toBe(true);
  });

  it("无强平价则不预警", () => {
    expect(shouldWarnLiquidation(100, undefined, undefined, now)).toBe(false);
  });
});

describe("encodeAssetId — HIP-3 asset id 编码", () => {
  it("核心永续(perpDexIndex 0)= meta 下标", () => {
    expect(encodeAssetId(0, 0)).toBe(0);
    expect(encodeAssetId(0, 42)).toBe(42);
  });
  it("HIP-3 builder 永续 = 100000 + dexIndex*10000 + 下标", () => {
    // 官方例:test:ABC perp_dex_index=1, index_in_meta=0 → 110000
    expect(encodeAssetId(1, 0)).toBe(110000);
    expect(encodeAssetId(2, 5)).toBe(120005);
  });
});

describe("resolveHlSymbol", () => {
  it("别名与 ticker 透传", () => {
    expect(resolveHlSymbol("Bitcoin")).toBe("BTC");
    expect(resolveHlSymbol("$doge")).toBe("DOGE");
    expect(resolveHlSymbol("hype")).toBe("HYPE");
    expect(resolveHlSymbol("TSLA")).toBe("TSLA");
    expect(resolveHlSymbol("a very long sentence")).toBeUndefined();
  });
});

describe("matchInUniverse — 大小写 + meme k 前缀", () => {
  const universe = new Set(["BTC", "ETH", "HYPE", "kPEPE", "kBONK"]);

  it("精确与大小写不敏感", () => {
    expect(matchInUniverse("BTC", universe)).toBe("BTC");
    expect(matchInUniverse("btc", universe)).toBe("BTC");
    expect(matchInUniverse("kpepe", universe)).toBe("kPEPE"); // 保留宇宙原始大小写
    expect(matchInUniverse("KPEPE", universe)).toBe("kPEPE");
  });

  it("别名全称落到符号", () => {
    expect(matchInUniverse("bitcoin", universe)).toBe("BTC");
    expect(matchInUniverse("hyperliquid", universe)).toBe("HYPE");
  });

  it("meme 直接名回退到 k 前缀(PEPE→kPEPE)", () => {
    expect(matchInUniverse("PEPE", universe)).toBe("kPEPE");
    expect(matchInUniverse("pepe", universe)).toBe("kPEPE");
    expect(matchInUniverse("$BONK", universe)).toBe("kBONK");
  });

  it("宇宙里没有则 undefined", () => {
    expect(matchInUniverse("DOGE", universe)).toBeUndefined();
    expect(matchInUniverse("整段中文句子", universe)).toBeUndefined();
  });
});
