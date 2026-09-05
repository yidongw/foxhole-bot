/**
 * Hyperliquid 永续引擎。对齐现货 src/trade/engine.ts 的结构:
 *   - paper 成交在本文件模拟;live 成交下沉到 client.ts(签名下单)。
 *   - 每笔开仓必过 checkPerpEntry 风控门。
 *   - 止损/止盈/最大持仓 全部方向感知(多空对称处理)。
 */

import { appendTradeJournal } from "../../trade/trade-journal.js";
import { resolveWebhook } from "../../notify/routes.js";
import { sendDiscordMessage } from "../../notify/discord.js";
import { sleep } from "../../lib/utils.js";
import { fdvTag } from "../../lib/format.js";
import { fetchDexJson } from "../../dex/dexscreener.js";
import type { DexPair } from "../../types.js";

import { loadHlConfig, type HlConfig } from "./config.js";
import { fetchAllFundingRates, fetchAssetInfo, fetchMidPrice } from "./info.js";
import { matchUniverseSymbol } from "./symbols.js";
import { checkPerpEntry } from "./risk.js";
import { liveClosePerp, liveOpenPerp } from "./client.js";
import {
  estimateLiquidationPrice,
  fundingAccrualUsd,
  findOpenPerp,
  isDailyReportDue,
  loadPerpPositions,
  mutatePerpPositions,
  mergePerpExitIntoFresh,
  openPerps,
  paperCashUsd,
  realizedPnlUsd,
  recordPerpExit,
  remainingFraction,
  shouldWarnLiquidation,
  totalPnlUsd,
  accountPnlUsd,
  type PerpPosition,
  type PerpSide,
} from "./positions.js";

function modeTag(config: HlConfig): string {
  if (config.mode === "paper") return "📝 PAPER";
  return config.testnet ? "🧪 LIVE-TESTNET" : "💸 LIVE";
}

async function notify(body: string): Promise<void> {
  await appendTradeJournal(body).catch(() => {});
  const url = resolveWebhook("trade");
  if (url) await sendDiscordMessage(url, body).catch((err) => console.error(err));
  else console.log(body);
}

/** 有利方向价格变动百分比(多头涨、空头跌为正)。 */
function favorableMovePct(p: PerpPosition, mark: number): number {
  const raw =
    p.side === "long"
      ? (mark - p.entryPriceUsd) / p.entryPriceUsd
      : (p.entryPriceUsd - mark) / p.entryPriceUsd;
  return raw * 100;
}

export interface PerpExitAction {
  fraction: number;
  reason: string;
  /** true = 硬性全平(止损/最大持仓),优先于止盈。 */
  full: boolean;
}

/** 评估某仓在给定 mark 下应触发的平仓动作(方向感知)。 */
export function evaluatePerpExits(
  p: PerpPosition,
  mark: number,
  config: HlConfig,
  now: Date = new Date(),
): PerpExitAction[] {
  const rem = remainingFraction(p);
  if (rem <= 1e-9) return [];

  // 硬止损:标的逆向变动超过 hardStopPct。
  const adverse =
    p.side === "long"
      ? (p.entryPriceUsd - mark) / p.entryPriceUsd
      : (mark - p.entryPriceUsd) / p.entryPriceUsd;
  if (adverse >= config.hardStopPct) {
    return [
      {
        fraction: rem,
        reason: `硬止损 ${(adverse * 100).toFixed(1)}% 逆向`,
        full: true,
      },
    ];
  }

  // 移动止损:从有利极值回撤 trailStopPct。
  const pullback =
    p.side === "long"
      ? (p.bestPriceUsd - mark) / p.bestPriceUsd
      : (mark - p.bestPriceUsd) / p.bestPriceUsd;
  if (config.trailStopPct > 0 && pullback >= config.trailStopPct) {
    return [
      {
        fraction: rem,
        reason: `移动止损 从极值回撤 ${(pullback * 100).toFixed(1)}%`,
        full: true,
      },
    ];
  }

  // 最大持仓时间。
  const ageMs = now.getTime() - new Date(p.openedAt).getTime();
  if (config.maxHoldHours > 0 && ageMs > config.maxHoldHours * 3_600_000) {
    return [
      { fraction: rem, reason: `最大持仓 ${config.maxHoldHours}h 到期`, full: true },
    ];
  }

  // 止盈阶梯(幂等:按已达档位应平比例 - 已止盈比例)。
  const favPct = favorableMovePct(p, mark);
  let desiredClosed = 0;
  for (const tier of config.takeProfits) {
    if (favPct >= tier.atPricePct) desiredClosed += tier.closeFraction;
  }
  const tpAlready = p.exits
    .filter((e) => e.reason.startsWith("止盈"))
    .reduce((s, e) => s + e.fraction, 0);
  const tpToClose = Math.min(Math.max(desiredClosed - tpAlready, 0), rem);
  if (tpToClose > 1e-9) {
    return [{ fraction: tpToClose, reason: `止盈 +${favPct.toFixed(1)}%`, full: false }];
  }

  return [];
}

/**
 * 永续标的对应现货的 FDV(trade-log 展示用,与现货消息对齐)。HL 的 kilo 前缀
 * (kPEPE/kBONK)剥掉后全链搜 DexScreener,取匹配符号里最深池的 fdv。
 * HIP-3 股票等无 DEX 现货的标的搜不到 → 返回 undefined,消息里省略。
 * 纯展示用途:任何失败都吞掉,绝不影响下单/平仓/风控。
 */
async function fetchPerpFdvUsd(symbol: string): Promise<number | undefined> {
  const spot = symbol.replace(/^k(?=[A-Z0-9]{2,})/, "");
  try {
    const data = await fetchDexJson<{ pairs?: DexPair[] }>(
      `/latest/dex/search?q=${encodeURIComponent(spot)}`,
    );
    const best = (data.pairs ?? [])
      .filter((p) => p.baseToken?.symbol?.toUpperCase() === spot.toUpperCase())
      .sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0];
    return best?.fdv || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 开永续仓。side=long/short,sizeUsd=名义敞口(<= HL_USD_PER_TRADE)。
 * 走全套风控 + 可交易性校验;paper 用 mid 价模拟,live 走签名下单。
 */
export async function openPerp(
  side: PerpSide,
  symbolRaw: string,
  sizeUsd: number,
  leverageRaw: number | undefined,
  reason: string,
  config: HlConfig = loadHlConfig(),
): Promise<string> {
  if (config.mode === "off") return "永续交易未开启 (HL_MODE=off)";
  // 宇宙感知匹配:处理大小写与 meme 的小写 k 前缀(PEPE→kPEPE),别强制大写。
  const symbol = await matchUniverseSymbol(symbolRaw, config);
  if (!symbol) {
    return `❌ ${symbolRaw} 匹配不到 HL 可交易符号(dex=${config.dex || "core"})`;
  }

  const asset = await fetchAssetInfo(config.testnet, symbol, config.dex || undefined);
  if (!asset) return `❌ ${symbol} 不在 HL 可交易宇宙内(dex=${config.dex || "core"})`;
  if (asset.isDelisted) return `❌ ${symbol} 已下架`;

  const leverage = Math.max(
    1,
    Math.min(Math.floor(leverageRaw ?? config.defaultLeverage), asset.maxLeverage),
  );

  const mark = await fetchMidPrice(config.testnet, symbol, config.dex || undefined);
  if (!mark) return `❌ ${symbol} 取不到价格`;

  // 维持保证金率(HL ≈ 最大杠杆初始保证金的一半),与 estimateLiquidationPrice 同源,
  // 供风控门用一致的强平距判定"止损须早于强平"。
  const mmf = asset.maxLeverage > 0 ? 1 / (2 * asset.maxLeverage) : 0;
  const file = await loadPerpPositions();
  const verdict = checkPerpEntry(config, file, {
    symbol,
    side,
    sizeUsd,
    leverage,
    maintenanceMarginFraction: mmf,
  });
  if (!verdict.ok) return `风控拒绝: ${verdict.reason}`;

  let entryPriceUsd = mark;
  let sizeCoins = sizeUsd / mark;
  let oid: number | undefined;

  if (config.mode === "live") {
    try {
      const fill = await liveOpenPerp(config, {
        side,
        symbol,
        sizeUsd,
        leverage,
        marginMode: config.marginMode,
        referencePriceUsd: mark,
        slippageBps: config.slippageBps,
      });
      entryPriceUsd = fill.avgPriceUsd;
      sizeCoins = fill.sizeCoins;
      oid = fill.oid;
    } catch (err) {
      return `❌ live 开仓失败: ${(err as Error).message}`;
    }
  }

  const actualSizeUsd = sizeCoins * entryPriceUsd;
  const position: PerpPosition = {
    id: `${symbol}-${side}-${Date.now()}`,
    mode: config.mode,
    venue: "hyperliquid",
    dex: config.dex || undefined,
    symbol,
    side,
    leverage,
    openedAt: new Date().toISOString(),
    entryPriceUsd,
    sizeUsd: actualSizeUsd,
    sizeCoins,
    marginUsd: actualSizeUsd / leverage,
    bestPriceUsd: entryPriceUsd,
    // 与风控门同源的维持保证金率(见上 mmf),保证估算与门禁一致。
    liquidationPriceUsd: estimateLiquidationPrice(side, entryPriceUsd, leverage, mmf),
    exits: [],
    status: "open",
    reason: reason.slice(0, 200),
    oid,
  };
  // Persist under a fresh write transaction with an in-lock dup re-check —
  // checkPerpEntry above ran on a pre-lock snapshot, so two concurrent opens of
  // the same symbol could both pass it (mirrors the spot aiBuy guard).
  const { result: dup } = await mutatePerpPositions((fresh) => {
    if (findOpenPerp(fresh, symbol)) return true;
    fresh.positions.push(position);
    return false;
  });
  if (dup) return `风控拒绝: 已持有 ${symbol} 永续仓（并发去重）`;

  const arrow = side === "long" ? "🟢 开多" : "🔴 开空";
  await notify(
    `${modeTag(config)} ${arrow} **${symbol}** ${leverage}x${fdvTag(await fetchPerpFdvUsd(symbol))}\n` +
      `名义 $${actualSizeUsd.toFixed(2)} (保证金 $${position.marginUsd.toFixed(2)}) @ $${entryPriceUsd.toPrecision(6)}\n` +
      `估算强平 $${position.liquidationPriceUsd?.toPrecision(6)} · 理由: ${reason}`,
  );
  return (
    `✅ ${arrow} ${symbol} ${leverage}x [${config.mode}] ` +
    `名义 $${actualSizeUsd.toFixed(2)} @ $${entryPriceUsd.toPrecision(6)} ` +
    `(${sizeCoins} 枚, 估算强平 $${position.liquidationPriceUsd?.toPrecision(6)})`
  );
}

/** 平掉 fraction (0..1] 的某永续仓。 */
export async function closePerp(
  symbolRaw: string,
  fraction = 1,
  config: HlConfig = loadHlConfig(),
): Promise<string> {
  const symbol = symbolRaw.trim().toUpperCase();
  const file = await loadPerpPositions();
  const p = findOpenPerp(file, symbol);
  if (!p) return `无 ${symbol} 持仓`;

  const mark = await fetchMidPrice(config.testnet, symbol, p.dex || undefined);
  if (!mark) return `❌ ${symbol} 取不到价格,稍后重试`;

  const sellFraction = Math.min(Math.max(fraction, 0), 1) * remainingFraction(p);
  if (sellFraction <= 1e-9) return `${symbol} 已无可平仓位`;

  const result = await executeClose(p, sellFraction, mark, config);
  // Apply to FRESH state under the write lock — clamps to what's actually left
  // if a concurrent writer already closed part of it (mirrors spot manualExit).
  const { result: applied } = await mutatePerpPositions((fresh) => {
    const fp = fresh.positions.find((x) => x.id === p.id);
    if (!fp || fp.status !== "open") return undefined;
    mergePerpExitIntoFresh(fp, result.exit);
    fp.bestPriceUsd =
      p.side === "long" ? Math.max(fp.bestPriceUsd, mark) : Math.min(fp.bestPriceUsd, mark);
    return fp;
  });
  if (!applied) return `${symbol} 已被并发平仓,跳过记账`;

  const pnl = totalPnlUsd(applied, mark);
  await notify(
    `${modeTag(config)} 📤 手动平仓 **${symbol}** ${(sellFraction * 100).toFixed(0)}% @ $${result.exit.markPriceUsd.toPrecision(6)}${fdvTag(await fetchPerpFdvUsd(symbol))}\n` +
      `本次已实现 ${result.exit.realizedPnlUsd >= 0 ? "+" : ""}$${result.exit.realizedPnlUsd.toFixed(2)} · 仓位盈亏 ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${applied.status})`,
  );
  return (
    `已平 ${(sellFraction * 100).toFixed(0)}% ${symbol} @ $${result.exit.markPriceUsd.toPrecision(6)} → ` +
    `本次盈亏 ${result.exit.realizedPnlUsd >= 0 ? "+" : ""}$${result.exit.realizedPnlUsd.toFixed(2)} (${applied.status})`
  );
}

interface CloseResult {
  exit: PerpPosition["exits"][number];
}

/** paper 直接按 mark 结算;live 下 reduce-only 反向单。 */
async function executeClose(
  p: PerpPosition,
  fraction: number,
  mark: number,
  config: HlConfig,
  reason = "manual exit",
): Promise<CloseResult> {
  // 请求平掉的币数与占原仓比例。paper 全额成交;live 按交易所实际回报覆盖。
  let coins = p.sizeCoins * fraction;
  let effFraction = fraction;
  let execPx = mark;
  let oid: number | undefined;

  if (p.mode === "live") {
    const fill = await liveClosePerp(config, {
      side: p.side,
      symbol: p.symbol,
      sizeCoins: coins,
      referencePriceUsd: mark,
      slippageBps: config.slippageBps,
    });
    // IOC 可能部分成交或完全不成交(滑点不足)。必须按**实际成交量**记账,
    // 否则本地账本会把没平掉的仓标成已平 → 与交易所真实持仓漂移、止损失效。
    if (!(fill.sizeCoins > 0)) {
      throw new Error("平仓 IOC 未成交(滑点不足?),不记账以免账本与交易所漂移");
    }
    execPx = fill.avgPriceUsd || mark;
    oid = fill.oid;
    coins = fill.sizeCoins;
    // 折算成占原始仓位的比例,并夹在剩余比例内防止取整过平。
    effFraction = Math.min(coins / p.sizeCoins, remainingFraction(p));
  }

  const diff = p.side === "long" ? execPx - p.entryPriceUsd : p.entryPriceUsd - execPx;
  const realizedPnlUsd = coins * diff;
  return {
    exit: {
      at: new Date().toISOString(),
      markPriceUsd: execPx,
      fraction: effFraction,
      realizedPnlUsd,
      reason,
      oid,
    },
  };
}

/** 刷新持仓行情、更新极值、跑止损止盈。挂到 monitor 的仓位 tick 或 cron。 */
export async function managePerpPositions(
  config: HlConfig = loadHlConfig(),
): Promise<void> {
  if (config.mode === "off") return;
  const file = await loadPerpPositions();
  const open = openPerps(file);
  if (!open.length) return;
  // Exit count per position at load — anything appended below is an exit this
  // tick, merged into fresh state at the end (resurrection-safe apply).
  const origExitCounts = new Map(open.map((p) => [p.id, p.exits.length]));

  // 每 tick 一次性拉全部资金费率,给所有持仓计费(不做 per-仓网络调用)。
  let fundingRates: Record<string, number> = {};
  try {
    fundingRates = await fetchAllFundingRates(config.testnet, config.dex || undefined);
  } catch (err) {
    console.error("perp funding rates fetch failed:", (err as Error).message);
  }

  for (const p of open) {
    // 单个符号取价失败(网络/HL 5xx)绝不能中断整轮管理——否则后面所有仓位
    // 这一 tick 全漏掉止损检查(集体失明)。对齐现货 managePositions 的防御:
    // 每仓独立 try/catch,坏一个只 continue 一个。
    let mark: number | undefined;
    try {
      mark = await fetchMidPrice(config.testnet, p.symbol, p.dex || undefined);
    } catch (err) {
      console.error(`perp price fetch failed ${p.symbol}:`, (err as Error).message);
      continue;
    }
    if (!mark) continue;

    p.bestPriceUsd =
      p.side === "long"
        ? Math.max(p.bestPriceUsd, mark)
        : Math.min(p.bestPriceUsd, mark);

    // 资金费累加(带符号)。缺率则跳过,lastFundingAt 不动,下 tick 再补算。
    const rate = fundingRates[p.symbol];
    if (rate != null) {
      const since = p.lastFundingAt ?? p.openedAt;
      const elapsedMs = Date.now() - new Date(since).getTime();
      const notionalRem = p.sizeUsd * remainingFraction(p);
      p.fundingPnlUsd =
        (p.fundingPnlUsd ?? 0) +
        fundingAccrualUsd(notionalRem, p.side, rate, elapsedMs);
      p.lastFundingAt = new Date().toISOString();
    }

    // 逼近强平预警(距强平 < 20% 时提示),按仓节流避免 15s 快循环刷屏。
    if (shouldWarnLiquidation(mark, p.liquidationPriceUsd, p.lastLiqWarnAt)) {
      const dist = Math.abs(mark - p.liquidationPriceUsd!) / mark;
      p.lastLiqWarnAt = new Date().toISOString();
      await notify(
        `⚠️ ${p.symbol} ${p.side} 逼近强平:mark $${mark.toPrecision(6)} vs 强平 $${p.liquidationPriceUsd!.toPrecision(6)} (距 ${(dist * 100).toFixed(1)}%)`,
      );
    }

    const actions = evaluatePerpExits(p, mark, config);
    for (const action of actions) {
      try {
        const result = await executeClose(p, action.fraction, mark, config, action.reason);
        recordPerpExit(p, result.exit);
        const pnl = totalPnlUsd(p, mark);
        await notify(
          `${modeTag(config)} 📤 **${p.symbol}** ${p.side} — ${action.reason}\n` +
            `平 ${(action.fraction * 100).toFixed(0)}% @ $${result.exit.markPriceUsd.toPrecision(6)} → ` +
            `本次 ${result.exit.realizedPnlUsd >= 0 ? "+" : ""}$${result.exit.realizedPnlUsd.toFixed(2)}${fdvTag(await fetchPerpFdvUsd(p.symbol))} · 仓位盈亏 ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${p.status})`,
        );
      } catch (err) {
        console.error(`perp exit failed ${p.symbol}:`, (err as Error).message);
      }
    }
    await sleep(200);
  }

  // Apply this tick's updates onto FRESH state under the write lock: skip any
  // position a concurrent `hl close` already closed (no resurrection), and
  // merge exits computed this tick (clamped to what's actually left).
  const { result: due } = await mutatePerpPositions((fresh) => {
    for (const p of open) {
      const fp = fresh.positions.find((x) => x.id === p.id);
      if (!fp || fp.status !== "open") continue;
      fp.bestPriceUsd = p.bestPriceUsd;
      if (p.fundingPnlUsd !== undefined) fp.fundingPnlUsd = p.fundingPnlUsd;
      if (p.lastFundingAt) fp.lastFundingAt = p.lastFundingAt;
      if (p.lastLiqWarnAt) fp.lastLiqWarnAt = p.lastLiqWarnAt;
      for (const e of p.exits.slice(origExitCounts.get(p.id) ?? 0)) {
        mergePerpExitIntoFresh(fp, e);
      }
    }
    // 日 P&L 播报(对齐现货):有持仓且距上次 >24h 时发一次账户快照。
    const d = isDailyReportDue(fresh.lastReportAt, fresh.positions.length > 0);
    if (d) fresh.lastReportAt = new Date().toISOString();
    return d;
  });

  if (due) {
    await notify(`📊 **永续 Daily P&L**\n${await formatPerpReport(config)}`);
  }
}

export async function formatPerpReport(
  config: HlConfig = loadHlConfig(),
): Promise<string> {
  const file = await loadPerpPositions();
  const open = openPerps(file);
  const lines: string[] = [];
  const marks: Record<string, number> = {};

  if (open.length) {
    lines.push(`**永续持仓 (${open.length})**`);
    for (const p of open) {
      const mark = await fetchMidPrice(config.testnet, p.symbol, p.dex || undefined);
      if (mark) marks[p.symbol] = mark;
      const pnl = totalPnlUsd(p, mark);
      const rem = remainingFraction(p);
      const arrow = p.side === "long" ? "🟢多" : "🔴空";
      lines.push(
        `• ${arrow} ${p.symbol} ${p.leverage}x [${p.mode}] ${(rem * 100).toFixed(0)}% 剩, ` +
          `开 $${p.entryPriceUsd.toPrecision(6)}${mark ? ` 现 $${mark.toPrecision(6)}` : ""}${fdvTag(await fetchPerpFdvUsd(p.symbol))}, ` +
          `盈亏 ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
      );
      await sleep(150);
    }
  } else {
    lines.push("无永续持仓");
  }

  const closed = file.positions.filter((p) => p.status === "closed");
  if (closed.length) {
    const realized = closed.reduce((s, p) => s + realizedPnlUsd(p), 0);
    lines.push(
      `**已平: ${closed.length} 笔, 已实现盈亏 ${realized >= 0 ? "+" : ""}$${realized.toFixed(2)}**`,
    );
  }

  // 权益 = 起始 + 全部已实现 + 未平仓未实现。保证金是锁定抵押品,不从权益里扣。
  const pnl = accountPnlUsd(file, marks);
  const equity = config.paperStartUsd + pnl;
  const pct = (pnl / config.paperStartUsd) * 100;
  const freeCash = paperCashUsd(file, config.paperStartUsd);
  lines.push(
    `**💰 永续账户(${config.mode}) $${equity.toFixed(2)}** ` +
      `(起始 $${config.paperStartUsd.toFixed(0)} · ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} / ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%) — ` +
      `可用现金 $${freeCash.toFixed(2)}`,
  );
  return lines.join("\n");
}
