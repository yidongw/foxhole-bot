/**
 * 永续开仓风控门禁。纯同步(可交易性等异步校验在 engine 里先做完再进来),
 * 对齐现货 src/trade/risk.ts 的写法:每一道都要过,live/paper 一视同仁。
 */

import type { HlConfig } from "./config.js";
import {
  findOpenPerp,
  notionalSince,
  openPerps,
  type PerpPositionsFile,
  type PerpSide,
} from "./positions.js";

export interface PerpEntryCandidate {
  symbol: string;
  side: PerpSide;
  /** 名义敞口 (USD)。 */
  sizeUsd: number;
  leverage: number;
  /** 维持保证金率(该资产 ≈ 1/(2×maxLeverage));缺省 0。用于强平距计算,须与
   *  estimateLiquidationPrice 一致,否则止损可能晚于真实强平。 */
  maintenanceMarginFraction?: number;
}

export interface PerpRiskVerdict {
  ok: boolean;
  reason?: string;
}

export function checkPerpEntry(
  config: HlConfig,
  file: PerpPositionsFile,
  candidate: PerpEntryCandidate,
  now: Date = new Date(),
): PerpRiskVerdict {
  if (config.mode === "off") return { ok: false, reason: "永续交易未开启 (HL_MODE=off)" };
  if (candidate.side !== "long" && candidate.side !== "short") {
    return { ok: false, reason: `非法方向: ${candidate.side}` };
  }
  if (!(candidate.sizeUsd > 0)) {
    return { ok: false, reason: "名义敞口必须 > 0" };
  }
  if (candidate.sizeUsd > config.usdPerTrade) {
    return {
      ok: false,
      reason: `名义敞口 $${Math.round(candidate.sizeUsd)} > 单笔上限 $${config.usdPerTrade}`,
    };
  }
  if (!(candidate.leverage > 0)) {
    return { ok: false, reason: "杠杆必须 > 0" };
  }
  if (candidate.leverage > config.maxLeverage) {
    return {
      ok: false,
      reason: `杠杆 ${candidate.leverage}x > 硬顶 ${config.maxLeverage}x`,
    };
  }
  // 硬止损必须早于强平触发。强平距 = 1/杠杆 − 维持保证金率(须与 estimateLiquidationPrice
  // 一致——早期只用 1/杠杆,对低最大杠杆的 meme 偏乐观,止损可能与真实强平重合)。
  // 若 hardStopPct 追平/超过它,交易所会先强平(亏光保证金),止损来不及生效。留 0.9 缓冲。
  if (config.hardStopPct > 0) {
    const mmf = candidate.maintenanceMarginFraction ?? 0;
    const liqDistance = Math.max(0, 1 / candidate.leverage - mmf);
    if (liqDistance <= 0 || config.hardStopPct >= liqDistance * 0.9) {
      return {
        ok: false,
        reason:
          `硬止损 ${(config.hardStopPct * 100).toFixed(0)}% 会晚于 ${candidate.leverage}x 的强平距≈${(liqDistance * 100).toFixed(0)}%` +
          `(爆仓风险)——降杠杆或收紧 HL_HARD_STOP_PCT`,
      };
    }
  }
  if (findOpenPerp(file, candidate.symbol)) {
    return { ok: false, reason: `${candidate.symbol} 已有持仓` };
  }
  if (openPerps(file).length >= config.maxOpenPerps) {
    return { ok: false, reason: `已达最大持仓数 (${config.maxOpenPerps})` };
  }

  // maxDailyNotionalUsd <= 0 关闭该限制。
  if (config.maxDailyNotionalUsd > 0) {
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const used = notionalSince(file, dayAgo);
    if (used + candidate.sizeUsd > config.maxDailyNotionalUsd) {
      return {
        ok: false,
        reason: `24h 名义敞口上限: $${Math.round(used)} + $${Math.round(candidate.sizeUsd)} > $${config.maxDailyNotionalUsd}`,
      };
    }
  }

  return { ok: true };
}
