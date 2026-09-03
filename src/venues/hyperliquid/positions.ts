/**
 * 永续仓位存储。刻意与现货 data/positions.json 分开——永续的字段(方向、杠杆、
 * 保证金、强平价、资金费)和现货 Position 差异太大,硬塞进去会污染现货引擎。
 * 独立 data/perp-positions.json,原子写。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "../../lib/atomic-json.js";
import type { HlMode } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERP_POSITIONS_PATH = path.resolve(
  __dirname,
  "../../../data/perp-positions.json",
);

export type PerpSide = "long" | "short";

export interface PerpExit {
  at: string;
  markPriceUsd: number;
  /** 平掉的比例(占原始仓位)。 */
  fraction: number;
  /** 该次平仓已实现盈亏 (USD,带符号)。 */
  realizedPnlUsd: number;
  reason: string;
  oid?: number;
}

export interface PerpPosition {
  id: string;
  mode: HlMode;
  venue: "hyperliquid";
  /** HIP-3 dex 名;空/缺 = 核心永续。 */
  dex?: string;
  symbol: string;
  side: PerpSide;
  leverage: number;
  openedAt: string;
  entryPriceUsd: number;
  /** 开仓名义敞口 (USD)。 */
  sizeUsd: number;
  /** 币的数量 = sizeUsd / entryPriceUsd(开仓时)。 */
  sizeCoins: number;
  /** 占用保证金 = sizeUsd / leverage。 */
  marginUsd: number;
  /** 有利极值:多头记最高价,空头记最低价,供移动止损用。 */
  bestPriceUsd: number;
  /** 估算强平价(isolated 近似;live 可用实盘值覆盖)。 */
  liquidationPriceUsd?: number;
  exits: PerpExit[];
  status: "open" | "closed";
  closedAt?: string;
  reason?: string;
  oid?: number;
  /** 上次发逼近强平预警的时间(节流用,避免 15s 快循环刷屏)。 */
  lastLiqWarnAt?: string;
  /** 累计资金费 P&L(带符号:正=收到,负=付出)。缺省视为 0。 */
  fundingPnlUsd?: number;
  /** 上次计资金费的时间(累加用;缺省时从 openedAt 起算)。 */
  lastFundingAt?: string;
}

export interface PerpPositionsFile {
  version: 1;
  lastReportAt?: string;
  positions: PerpPosition[];
}

export async function loadPerpPositions(): Promise<PerpPositionsFile> {
  try {
    const raw = await readFile(PERP_POSITIONS_PATH, "utf8");
    return JSON.parse(raw) as PerpPositionsFile;
  } catch {
    return { version: 1, positions: [] };
  }
}

export async function savePerpPositions(file: PerpPositionsFile): Promise<void> {
  await writeJsonAtomic(PERP_POSITIONS_PATH, file);
}

export function openPerps(file: PerpPositionsFile): PerpPosition[] {
  return file.positions.filter((p) => p.status === "open");
}

export function findOpenPerp(
  file: PerpPositionsFile,
  symbol: string,
): PerpPosition | undefined {
  return file.positions.find(
    (p) => p.status === "open" && p.symbol.toUpperCase() === symbol.toUpperCase(),
  );
}

export function remainingFraction(p: PerpPosition): number {
  return Math.max(0, 1 - p.exits.reduce((s, e) => s + e.fraction, 0));
}

export function realizedPnlUsd(p: PerpPosition): number {
  return p.exits.reduce((s, e) => s + e.realizedPnlUsd, 0);
}

/** 剩余持仓在给定 mark 下的未实现盈亏(方向感知)。 */
export function unrealizedPnlUsd(p: PerpPosition, markPriceUsd: number): number {
  const coins = p.sizeCoins * remainingFraction(p);
  const diff =
    p.side === "long"
      ? markPriceUsd - p.entryPriceUsd
      : p.entryPriceUsd - markPriceUsd;
  return coins * diff;
}

/** 已实现 + 未实现 + 累计资金费盈亏。 */
export function totalPnlUsd(p: PerpPosition, markPriceUsd?: number): number {
  const unreal =
    p.status === "open" && markPriceUsd != null
      ? unrealizedPnlUsd(p, markPriceUsd)
      : 0;
  return realizedPnlUsd(p) + unreal + (p.fundingPnlUsd ?? 0);
}

/**
 * 某仓在 elapsedMs 内的资金费 P&L(带符号:正=收到,负=付出)。HL 资金费按小时收,
 * rate>0 时多头付给空头。notional 用剩余名义敞口。纯函数,可单测。
 */
export function fundingAccrualUsd(
  notionalUsd: number,
  side: PerpSide,
  hourlyRate: number,
  elapsedMs: number,
): number {
  if (!(notionalUsd > 0) || !Number.isFinite(hourlyRate) || elapsedMs <= 0) {
    return 0;
  }
  const magnitude = notionalUsd * hourlyRate * (elapsedMs / 3_600_000);
  // 多头在 rate>0 时付出(负 P&L),空头收到(正);rate<0 反之。
  return side === "long" ? -magnitude : magnitude;
}

/**
 * 自 sinceIso 起新开仓位的累计名义敞口(24h 上限的计量基准)。
 * 用剩余比例折算——已平掉的部分不再占用敞口额度。
 */
export function notionalSince(file: PerpPositionsFile, sinceIso: string): number {
  return file.positions
    .filter((p) => p.openedAt >= sinceIso)
    .reduce((sum, p) => sum + p.sizeUsd * remainingFraction(p), 0);
}

/**
 * 账户总盈亏(全部已实现 + 未平仓未实现)。marks 按 symbol 提供现价;缺失的
 * 未平仓位只算已实现部分。用于 paper 权益 = 起始 + 本函数。
 *
 * 注意:占用保证金**不从权益里扣**——它是锁定的抵押品、仍属于你的钱。早期把
 * 保证金当成花掉的钱扣掉,导致刚开仓价格没动就显示亏损(等于占用保证金)。
 */
export function accountPnlUsd(
  file: PerpPositionsFile,
  marks: Record<string, number>,
): number {
  return file.positions.reduce((sum, p) => {
    const mark = p.status === "open" ? marks[p.symbol] : undefined;
    return sum + totalPnlUsd(p, mark);
  }, 0);
}

/** paper 可用现金(非权益):起始 - 各仓占用保证金 + 已实现盈亏。 */
export function paperCashUsd(
  file: PerpPositionsFile,
  startUsd: number,
): number {
  let cash = startUsd;
  for (const p of file.positions) {
    cash -= p.marginUsd * remainingFraction(p);
    cash += realizedPnlUsd(p);
  }
  return cash;
}

export function recordPerpExit(p: PerpPosition, exit: PerpExit): void {
  p.exits.push(exit);
  if (remainingFraction(p) <= 1e-9) {
    p.status = "closed";
    p.closedAt = exit.at;
  }
}

/**
 * 是否该发逼近强平预警。距强平 < thresholdPct 才提示,且距上次预警需超过
 * cooldownMs——否则 15s 快循环里每 tick 都发,会向 Discord 刷屏(~240 条/小时)。
 */
export function shouldWarnLiquidation(
  mark: number,
  liqPrice: number | undefined,
  lastWarnAt: string | undefined,
  now: Date = new Date(),
  cooldownMs = 30 * 60_000,
  thresholdPct = 0.2,
): boolean {
  if (!liqPrice || !(mark > 0)) return false;
  const dist = Math.abs(mark - liqPrice) / mark;
  if (dist >= thresholdPct) return false;
  if (lastWarnAt && now.getTime() - new Date(lastWarnAt).getTime() < cooldownMs) {
    return false;
  }
  return true;
}

/**
 * 是否到了播报日 P&L 的时点。无持仓不播报;从未播报过则播报;否则距上次超过
 * periodMs 才播报。对齐现货 managePositions 的日报节奏,给永续同等被动可观测性。
 */
export function isDailyReportDue(
  lastReportAt: string | undefined,
  hasPositions: boolean,
  now: Date = new Date(),
  periodMs = 24 * 60 * 60 * 1000,
): boolean {
  if (!hasPositions) return false;
  if (!lastReportAt) return true;
  return now.getTime() - new Date(lastReportAt).getTime() > periodMs;
}

/** isolated 保证金强平价近似(忽略维持保证金率与手续费,偏保守)。 */
export function estimateLiquidationPrice(
  side: PerpSide,
  entryPriceUsd: number,
  leverage: number,
  maintenanceMarginFraction = 0,
): number {
  if (leverage <= 0) return 0;
  // 真实强平在维持保证金处、而非权益归零处:逆向幅度 = 1/杠杆 − 维持保证金率。
  // 漏掉维持保证金会把强平价放得比实际远 → 逼近预警偏晚(低杠杆资产尤甚)。
  const adverse = Math.max(0, 1 / leverage - maintenanceMarginFraction);
  const move = entryPriceUsd * adverse;
  return side === "long" ? entryPriceUsd - move : entryPriceUsd + move;
}
