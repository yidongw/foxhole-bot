import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchDexJson, fetchTokenPairs } from "../dex/dexscreener.js";
import { fetchPaprikaTokenPriceUsd } from "../dex/dexpaprika.js";
import { selectDeepestBasePair } from "../chains/generic-analysis.js";
import { getAdapter, positionChain } from "../chains/registry.js";
import { tradeEnabledChains, type ChainId } from "../chains/adapter.js";
import { sendDiscordMessage } from "../notify/discord.js";
import { appendAlertLog } from "../notify/alert-log.js";
import { appendTradeJournal } from "./trade-journal.js";
import { resolveWebhook } from "../notify/routes.js";
import { postToSignalThread } from "../notify/signal-threads.js";
import { sleep } from "../lib/utils.js";
import { fdvTag, gmgnLink } from "../lib/format.js";
import type { SignalEvaluation } from "../signals/types.js";
import type { DexPair } from "../types.js";
import { formatUnits } from "viem";
import { MAINNET_ADDRESSES } from "hoodchain";
import { getTradingClient, getErc20Balance } from "../chain/client.js";
import {
  loadTradeConfig,
  paperStartFor,
  resolveTradeMode,
  tradingActive,
  type TradeConfig,
  type TradeMode,
} from "./config.js";
import {
  loadPositions,
  openPositions,
  findOpen,
  paperCashUsd,
  recordExit,
  remainingFraction,
  mutatePositions,
  mergeExitIntoFresh,
  totalPnlUsd,
  realizedUsd,
  mergeStrategy,
  formatStrategy,
  type Position,
  type PositionStrategy,
  type PositionsFile,
} from "./positions.js";
import { checkEntry } from "./risk.js";
import { appendDecision } from "./decisions.js";
import { checkTokenSafety, safetyGateEnabled } from "./safety.js";
import { evaluateExits, type ExitAction } from "./exits.js";
import type { TradeFill } from "./execute.js";
import {
  ADVISOR_COOLDOWN_MS,
  adviseExit,
  advisorAvailable,
} from "./advisor.js";

export interface EngineOptions {
  dryRun?: boolean;
  webhookUrl?: string;
}

async function notify(
  body: string,
  options: EngineOptions,
  chain?: string,
  tokenAddress?: string,
): Promise<void> {
  if (options.dryRun) {
    console.log("--- DRY RUN TRADE ---\n" + body + "\n");
    return;
  }
  await appendAlertLog(body);
  // Trade events go to the (per-chain) 交易日志 channel when configured.
  const url = options.webhookUrl ?? resolveWebhook("trade", chain);
  if (url) await sendDiscordMessage(url, body).catch((err) => console.error(err));
  else console.log(body);
  // Mirror into the token's signal thread so 交易思考全在一处
  if (chain && tokenAddress) {
    await postToSignalThread(chain, tokenAddress, body).catch(() => {});
  }
}

function modeTag(config: TradeConfig): string {
  return config.mode === "paper" ? "📝 PAPER" : "💸 LIVE";
}

const signedUsd = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;

/** 代币数量：≥1000 取整加千分位（8万枚不用两位小数），否则保 4 位有效数字。 */
const fmtQty = (n: number) =>
  n >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toPrecision(4);

/**
 * 统一成交消息（买卖同构，用户 2026-09-05 修订）：
 *   头行   <mode> 📥买入/📤卖出 **SYM** [chain] · FDV
 *   (买入) 建仓 · 均价 $入                      ← 价格锚点，与卖出的「均价」同措辞
 *          投入 $cost · 持 N 枚                 ← 花了多少 / 持多少
 *   (卖出) 平X% · 均价 $入 → $出 (±N%)        ← 价格锚点，明确是买入价→卖出价
 *          收回 $proceeds · 盈亏 ±$            ← 全平/单笔：只一个盈亏数
 *          收回 $proceeds · 本次实现 ±$ · 仓位盈亏 ±$ (open 剩X%)  ← 分批才拆两数
 *   理由: 本次买/卖的动机
 *   策略/后续: 接下来怎么管（「」内为策略理由）；清仓则注明停止跟踪
 */
function fillMessage(o: {
  modeText: string;
  side: "in" | "out";
  symbol: string;
  chain: string;
  token: string;
  fdvUsd?: number;
  entryPriceUsd?: number;
  /** 买入侧：投入的美元（记账成本）与拿到的代币数。 */
  costUsd?: number;
  amountTokens?: number;
  /** 卖出侧：本次卖出占原仓的比例（0..1）。 */
  fraction?: number;
  exitPriceUsd?: number;
  proceedsUsd?: number;
  thisRealizedUsd?: number;
  positionPnlUsd?: number;
  statusText?: string;
  reason: string;
  follow: string;
  txHash?: string;
}): string {
  const lines = [
    `${o.modeText} ${o.side === "in" ? "📥 买入" : "📤 卖出"} **${o.symbol}** [${o.chain}]${fdvTag(o.fdvUsd)}`,
  ];
  if (o.side === "in") {
    lines.push(`建仓 · 均价 $${(o.entryPriceUsd ?? 0).toPrecision(4)}`);
    lines.push(
      `投入 $${(o.costUsd ?? 0).toFixed(2)} · 持 ${fmtQty(o.amountTokens ?? 0)} 枚`,
    );
  } else {
    const entry = o.entryPriceUsd ?? 0;
    const exit = o.exitPriceUsd ?? 0;
    const movePct = entry > 0 ? (exit / entry - 1) * 100 : 0;
    const moveTag = entry > 0 ? ` (${movePct >= 0 ? "+" : ""}${movePct.toFixed(0)}%)` : "";
    lines.push(
      `平 ${((o.fraction ?? 1) * 100).toFixed(0)}% · 均价 $${entry.toPrecision(4)} → $${exit.toPrecision(4)}${moveTag}`,
    );
    // 全平/单笔出场时 本次实现 == 仓位盈亏，合并成一个数；分批(前面吃过TP)才拆开。
    const single =
      Math.abs((o.thisRealizedUsd ?? 0) - (o.positionPnlUsd ?? 0)) < 0.005;
    lines.push(
      single
        ? `收回 $${(o.proceedsUsd ?? 0).toFixed(2)} · 盈亏 ${signedUsd(o.positionPnlUsd ?? 0)} (${o.statusText})`
        : `收回 $${(o.proceedsUsd ?? 0).toFixed(2)} · 本次实现 ${signedUsd(o.thisRealizedUsd ?? 0)} · 仓位盈亏 ${signedUsd(o.positionPnlUsd ?? 0)} (${o.statusText})`,
    );
  }
  lines.push(`理由: ${o.reason}`);
  lines.push(o.follow);
  const link = gmgnLink(o.chain, o.token);
  if (link) lines.push(link);
  if (o.txHash) lines.push(`Tx: ${o.txHash}`);
  return lines.join("\n");
}

/**
 * Capital available to size a trade on this chain, in USD.
 * paper = that chain's paper cash; live = on-chain base-currency balance
 * (RB=USDG≈$1). Other live chains aren't balance-aware yet → Infinity.
 */
async function availableCapitalUsd(
  chain: string,
  mode: TradeMode,
  config: TradeConfig,
  file: PositionsFile,
): Promise<number> {
  if (mode === "paper") {
    return paperCashUsd(file, paperStartFor(config, chain), chain);
  }
  if (chain === "robinhood") {
    try {
      const wallet = getTradingClient().account?.address;
      if (!wallet) return 0;
      const bal = await getErc20Balance(
        MAINNET_ADDRESSES.usdg as `0x${string}`,
        wallet as `0x${string}`,
      );
      return Number(formatUnits(bal, 6)); // USDG = 6 decimals, ~$1
    } catch {
      return 0;
    }
  }
  return Infinity;
}

/**
 * Per-trade USD ceiling: a fraction of available capital when sizePct>0
 * (→ multiple positions, scales with balance), else the fixed live cap.
 */
function sizeCapUsd(
  available: number,
  mode: TradeMode,
  config: TradeConfig,
): number {
  if (config.sizePct > 0) return config.sizePct * available;
  if (mode === "live" && config.usdPerTrade > 0) return config.usdPerTrade;
  return Infinity;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSITIONS_WEB_PATH = path.resolve(__dirname, "../../web/data/positions.json");
const PAUSE_FLAG_PATH = path.resolve(__dirname, "../../data/trading-paused");

/** Per-position throttle for the loud live exit-failure alert (30 min). */
const liveExitFailNotifiedAt = new Map<string, number>();

/** Pause blocks NEW entries only — exits and stops keep running. */
export function tradingPaused(): boolean {
  return existsSync(PAUSE_FLAG_PATH);
}

export async function setTradingPaused(paused: boolean): Promise<void> {
  if (paused) {
    await mkdir(path.dirname(PAUSE_FLAG_PATH), { recursive: true });
    await writeFile(PAUSE_FLAG_PATH, new Date().toISOString(), "utf8");
  } else {
    await rm(PAUSE_FLAG_PATH, { force: true });
  }
}

function matchesPosition(p: Position, query: string): boolean {
  const q = query.toLowerCase();
  return (
    p.token.toLowerCase() === q ||
    (p.symbol ?? "").toLowerCase() === q
  );
}

/**
 * Corroborate an adapter price that lands absurdly far from the position's own
 * high-water mark, in EITHER direction. The exit loop already guards downside
 * bad ticks (see the glitch guard below); upside ones are just as damaging on a
 * manual exit: MarsCoin (real price $0.1224, high-water $0.1379) read back as
 * $149.29, which booked $25k of phantom paper proceeds AND poisoned the
 * high-water mark, so the trail stop immediately liquidated the rest. Returns
 * the corroborated price, or undefined when nothing confirms the read.
 */
async function corroboratePrice(
  position: Position,
  chain: ChainId,
  price: number,
): Promise<number | undefined> {
  if (price > position.highWaterUsd * 0.35 && price < position.highWaterUsd * 5) return price;
  // The old confirm re-read DexScreener FIRST and only fell back to DexPaprika
  // when it errored — a degraded DexScreener response confirms its own garbage
  // (OPTIMUS 2026-09-04 12:27: bought $0.0204, "hard stopped" 11s later at
  // $0.0028 ≈ real ÷7.3 while the token never fell at all; both reads hit the
  // same bad TSLA-quoted conversion). Extreme moves now need BOTH independent
  // sources to agree; any in-band source corrects the read instead.
  const [dexRead, paprikaRead] = await Promise.all([
    fetchTokenPairs(position.token, chain)
      .then((ps) => Number(selectDeepestBasePair(ps, position.token)?.priceUsd) || undefined)
      .catch(() => undefined),
    fetchPaprikaTokenPriceUsd(chain, position.token).catch(() => undefined),
  ]);
  return decideExtremePrice(position.highWaterUsd, price, dexRead, paprikaRead);
}

/**
 * Before a STOP market-sells the whole position, re-confirm the triggering price
 * against two fresh independent sources. The glitch guard only corroborates
 * ticks that fall OUTSIDE [hw×0.35, hw×5]; a hard stop set deeper than 35%
 * therefore fires on a single uncorroborated in-band tick. FARM (2026-09-05,
 * 1.3-min-old RB pool) was "hard stopped: 45% below entry" on a ~$0.000036 tick
 * that sat just inside the 35%-off band while the real pool price was $0.000143
 * (2.2× entry) — the noise tick liquidated a winner. Returns true only if the
 * HIGHEST fresh independent read still triggers a stop (i.e. every source agrees
 * price is low): a genuine dump confirms here and exits now, a noise tick is
 * skipped and re-evaluated next tick.
 */
async function confirmStopTriggered(
  position: Position,
  chain: ChainId,
  config: TradeConfig,
): Promise<boolean> {
  const [dexRead, paprikaRead] = await Promise.all([
    fetchTokenPairs(position.token, chain)
      .then((ps) => Number(selectDeepestBasePair(ps, position.token)?.priceUsd) || undefined)
      .catch(() => undefined),
    fetchPaprikaTokenPriceUsd(chain, position.token).catch(() => undefined),
  ]);
  const fresh = [dexRead, paprikaRead].filter((v): v is number => v != null && v > 0);
  if (!fresh.length) return false; // can't confirm → skip; a real dump exits next tick
  const best = Math.max(...fresh);
  return evaluateExits(position, best, config).some(isStopAction);
}

/** A stop is a rail that market-sells on downside; TP/advisor exits are not. */
function isStopAction(action: ExitAction): boolean {
  return (
    action.reason.startsWith("hard stop") ||
    action.reason.startsWith("trail stop")
  );
}

/**
 * Pure decision for an out-of-band price read (exported for tests).
 * - Any source back inside the sane band [hw×0.35, hw×5] wins: the original
 *   read was a glitch; trade on the in-band price.
 * - Both sources out-of-band on the SAME side as the read (within 3x of it):
 *   the move is real (true rug or true 5x) — keep the original read.
 * - Otherwise (sources missing or contradictory): undefined — skip this tick;
 *   a real rug exits on the next tick once sources agree.
 */
export function decideExtremePrice(
  hw: number,
  price: number,
  ...sources: Array<number | undefined>
): number | undefined {
  const inBand = (v: number) => v > hw * 0.35 && v < hw * 5;
  const live = sources.filter((v): v is number => v != null && v > 0);
  const sane = live.find(inBand);
  if (sane != null) return sane;
  if (
    live.length >= 2 &&
    live.every((v) => !inBand(v) && v / price < 3 && price / v < 3 && v < hw === price < hw)
  ) {
    return price;
  }
  return undefined;
}

/**
 * Manually exit `fraction` (0..1] of an open position by symbol or address.
 * Sells at the position's own mode (paper stays paper). Returns a human
 * summary for the control surface.
 */
export async function manualExit(
  query: string,
  fraction = 1,
  reason?: string,
): Promise<string> {
  const file = await loadPositions();
  const position = openPositions(file).find((p) => matchesPosition(p, query));
  if (!position) return `No open position matching "${query}".`;

  const chain = positionChain(position.chain);
  const raw = await getAdapter(chain).priceUsd(position.token);
  if (!raw || raw <= 0) return `No price available for ${position.symbol} — try again.`;
  const price = await corroboratePrice(position, chain, raw);
  if (!price) {
    return `Exit skipped for ${position.symbol}: price $${raw} is far off high-water $${position.highWaterUsd} and no second source could confirm it — try again.`;
  }
  let fdvUsd: number | undefined;
  try {
    fdvUsd = selectDeepestBasePair(
      await fetchTokenPairs(position.token, chain),
      position.token,
    )?.fdv;
  } catch {}

  const sellFraction = Math.min(Math.max(fraction, 0), 1) * remainingFraction(position);
  const config = { ...loadTradeConfig(), mode: position.mode };
  try {
    // Slow work (chain sell in live mode) stays outside the ledger lock; the
    // exit is then merged into FRESH state so a concurrent engine tick can't
    // resurrect the position with a stale save (pussy 2026-09-04).
    const fill = await executeSell(chain, config, position, sellFraction, price);
    const exit = {
      at: new Date().toISOString(),
      priceUsd: fill.priceUsd,
      fraction: sellFraction,
      proceedsUsd: fill.proceedsUsd ?? 0,
      reason: reason ? `manual exit: ${reason}`.slice(0, 160) : "manual exit",
      txHash: fill.txHash,
    };
    const { file: freshFile, result: freshPos } = await mutatePositions((f) => {
      const fp = f.positions.find((p) => p.id === position.id);
      if (!fp || fp.status !== "open") return undefined;
      mergeExitIntoFresh(fp, exit);
      fp.highWaterUsd = Math.max(fp.highWaterUsd, price);
      return fp;
    });
    if (!freshPos) {
      return `Exit skipped for ${position.symbol}: position already closed by another writer.`;
    }
    const positionFresh = freshPos;
    await writePositionsJson(freshFile, { [position.token.toLowerCase()]: price });
    position.status = positionFresh.status;
    position.exits = positionFresh.exits;
    const pnl = totalPnlUsd(positionFresh, price);
    await appendTradeJournal(
      `📤 手动平仓 ${position.symbol} [${chain}/${position.mode}] 卖出 ${(sellFraction * 100).toFixed(0)}% @ $${fill.priceUsd.toPrecision(4)} → $${(fill.proceedsUsd ?? 0).toFixed(2)}${fdvTag(fdvUsd)} | 持仓盈亏 ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | 策略: ${formatStrategy(position.strategy)}`,
    );
    // Every fill belongs in the 交易日志 channel. Buys (aiBuy) and mechanical
    // exits (managePositions) always notified, but AI/manual sells via the CLI
    // only wrote the journal — the ASS exit on 2026-09-04 never reached the
    // trade log and the ledger channel silently missed a whole class of fills.
    const remainingPct = remainingFraction(positionFresh) * 100;
    await notify(
      fillMessage({
        modeText: modeTag(config),
        side: "out",
        symbol: position.symbol ?? position.token,
        chain,
        token: position.token,
        fdvUsd,
        fraction: sellFraction,
        entryPriceUsd: position.entryPriceUsd,
        exitPriceUsd: fill.priceUsd,
        proceedsUsd: fill.proceedsUsd ?? 0,
        thisRealizedUsd: (fill.proceedsUsd ?? 0) - sellFraction * position.costUsd,
        positionPnlUsd: pnl,
        statusText:
          positionFresh.status === "closed" ? "closed" : `open 剩${remainingPct.toFixed(0)}%`,
        reason: reason ?? "手动平仓（未附理由）",
        follow:
          positionFresh.status === "closed"
            ? "后续: 已清仓，停止跟踪"
            : `策略: ${formatStrategy(positionFresh.strategy)}`,
      }),
      {},
      chain,
      position.token,
    );
    await appendDecision({
      verdict: "sell",
      chain,
      token: position.token,
      symbol: position.symbol,
      reason: reason ?? "手动平仓",
      snap: { price: fill.priceUsd, mcap: fdvUsd },
    });
    return (
      `Sold ${(sellFraction * 100).toFixed(0)}% of ${position.symbol} [${chain}/${position.mode}] ` +
      `@ $${fill.priceUsd.toPrecision(4)} → $${(fill.proceedsUsd ?? 0).toFixed(2)}${fdvTag(fdvUsd)}. ` +
      `Position P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${position.status}).`
    );
  } catch (err) {
    return `Exit failed for ${position.symbol}: ${(err as Error).message}`;
  }
}

/**
 * AI-decided entry. Same gates as automatic entries (risk caps, dup checks,
 * safety incl. chart) — the AI chooses token/size/timing but cannot bypass
 * any control. Size is clamped to the per-trade cap.
 */
export async function aiBuy(
  chainId: string,
  address: string,
  usd: number,
  reason: string,
  opts?: { smartMoney?: boolean; momentum?: boolean; strategy?: PositionStrategy },
): Promise<string> {
  const chain = positionChain(chainId);
  const base = loadTradeConfig();
  const mode = resolveTradeMode(base, chain);
  if (mode === "off") return `${chain} 链交易未开启 (TRADE_MODE/TRADE_MODE_${chain.toUpperCase()})`;
  // Chain-scoped config: shadow the global mode so every downstream check
  // (cash accounting, position.mode, executeBuy, labels) is per-chain correct.
  const config = { ...base, mode };
  if (tradingPaused()) return "交易已暂停 (/resume 恢复)";

  const analysis = await getAdapter(chain).analyze(address);
  const triggers = ["ai_decision"];
  if (opts?.smartMoney) triggers.push("smart_money");
  if (opts?.momentum) triggers.push("momentum_strong");
  const candidate = {
    token: analysis.address,
    chain,
    symbol: analysis.symbol,
    priceUsd: analysis.priceUsd,
    liquidityUsd: analysis.liquidityUsd ?? 0,
    triggers,
  };

  const file = await loadPositions();
  // 2026-09-04 用户拆除预算类限制:单笔 $50/$25 夹子取消,买多少由 AI 判断。
  // 唯一保留的是账本现金(paper 不许透支;live 由链上余额天然约束)——这是
  // 记账完整性,不是策略限制。止损/安全门(防骗子合约)不属于预算,原样保留。
  // Size relative to the chain's available capital (paper cash / on-chain
  // base-currency balance). With TRADE_SIZE_PCT>0 each trade takes a fraction
  // of it → naturally多个仓 that scale with balance; else fixed usdPerTrade cap.
  // The AI's requested `usd` is honored up to that ceiling (and never > available).
  const available = await availableCapitalUsd(chain, config.mode, config, file);
  const clamped = Math.min(usd, available, sizeCapUsd(available, config.mode, config));
  if (!(clamped > 0)) {
    const av = Number.isFinite(available) ? `$${available.toFixed(2)}` : "∞";
    return `风控拒绝: 可用资金不足 (可用 ${av})`;
  }
  const verdict = checkEntry({ ...config, usdPerTrade: clamped }, file, candidate);
  if (!verdict.ok) return `风控拒绝: ${verdict.reason}`;

  if (safetyGateEnabled()) {
    const safety = await checkTokenSafety(chain, address, analysis.primaryPairAddress);
    if (!safety.ok) {
      await appendTradeJournal(
        `🛑 AI买入被安全门否决 ${candidate.symbol} [${chain}] — ${safety.flags.join(", ")}`,
      );
      return `安全门否决: ${safety.flags.join(", ")}`;
    }
  }

  const fill = await executeBuy(chain, config, address, candidate.priceUsd!, clamped);
  const position: Position = {
    id: `${address.toLowerCase()}-${Date.now()}`,
    mode: config.mode,
    chain,
    token: analysis.address,
    symbol: analysis.symbol,
    trigger: `ai_decision: ${reason}`.slice(0, 200),
    openedAt: new Date().toISOString(),
    entryPriceUsd: fill.priceUsd,
    entryFdvUsd: analysis.fdvUsd,
    amountTokens: fill.amountTokens,
    costUsd: clamped,
    highWaterUsd: fill.priceUsd,
    exits: [],
    status: "open",
    txHash: fill.txHash,
  };
  // Per-position exit plan set at entry (falls back to config where unset).
  if (opts?.strategy) mergeStrategy(position, opts.strategy);
  // Push under the ledger lock with a FRESH cash re-check — the advisory check
  // above ran on a snapshot that may be minutes stale (MarsCoin's $60 buy was
  // eaten by exactly this race on 2026-09-04).
  const { file: freshFile, result: ok } = await mutatePositions((f) => {
    // Dup re-check INSIDE the lock — checkEntry ran on a pre-lock snapshot, so
    // two concurrent deciders could both pass its 一币一仓 gate on the same new
    // token and double-open it. Re-evaluate against FRESH state here (mirrors
    // the freshCash re-check below). Harmless today under the single-decider
    // lock; the guarantee that makes multi-decider safe against double-buy.
    if (findOpen(f, position.token)) return "dup" as const;
    const freshCash =
      config.mode === "paper"
        ? paperCashUsd(f, paperStartFor(config, chain), chain)
        : Infinity;
    if (freshCash < clamped) return "cash" as const;
    f.positions.push(position);
    return "ok" as const;
  });
  if (ok === "dup") return `风控拒绝: 已持有 ${position.symbol ?? position.token} 仓位（并发去重）`;
  if (ok === "cash") return `风控拒绝: 可用现金不足（并发核算后）`;
  await writePositionsJson(freshFile);
  const strat = formatStrategy(position.strategy);
  await appendTradeJournal(
    `📥 AI开仓 ${position.symbol} [${chain}/${config.mode}] $${clamped} @ $${fill.priceUsd.toPrecision(4)} (${fill.amountTokens.toFixed(2)} 枚) — 理由: ${reason} | 策略: ${strat}${fill.txHash ? ` tx:${fill.txHash}` : ""}`,
  );
  const link = gmgnLink(chain, position.token);
  await notify(
    fillMessage({
      modeText: modeTag(config),
      side: "in",
      symbol: position.symbol ?? position.token,
      chain,
      token: position.token,
      fdvUsd: analysis.fdvUsd,
      entryPriceUsd: fill.priceUsd,
      costUsd: clamped,
      amountTokens: fill.amountTokens,
      reason,
      follow: `策略: ${strat}`,
      txHash: fill.txHash,
    }),
    {},
    chain,
    position.token,
  );
  // Durable decision trail (outlives positions.json once the position closes):
  // lets a later decider see "you already bought this Nh ago" on re-entry.
  await appendDecision({
    verdict: "buy",
    chain,
    token: position.token,
    symbol: position.symbol,
    reason,
    snap: { price: fill.priceUsd, liq: analysis.liquidityUsd, mcap: analysis.fdvUsd },
    source: triggers.join(","),
  });
  return `✅ 已开仓 ${position.symbol} [${chain}/${config.mode}] $${clamped} @ $${fill.priceUsd.toPrecision(4)} (${fill.amountTokens.toFixed(2)} 枚) | 策略: ${strat}`;
}

/**
 * Set or adjust an open position's exit strategy (per-position rails). The AI
 * calls this at buy time via a fresh plan and later to re-tune as the position
 * develops — a de-risked runner can widen its trail, a broken thesis can
 * tighten its stop. Fields left out keep their current value; only supplied
 * fields change. Returns a human summary for the control surface / thread.
 */
export async function setStrategy(
  query: string,
  patch: PositionStrategy,
): Promise<string> {
  const { file, result: position } = await mutatePositions((f) => {
    const fp = openPositions(f).find((p) => matchesPosition(p, query));
    if (fp) mergeStrategy(fp, patch);
    return fp;
  });
  if (!position) return `No open position matching "${query}".`;
  await writePositionsJson(file);
  const chain = positionChain(position.chain);
  const summary = formatStrategy(position.strategy);
  await appendTradeJournal(
    `🎯 调整策略 ${position.symbol} [${chain}/${position.mode}] — ${summary}`,
  );
  await postToSignalThread(chain, position.token, `🎯 策略更新: ${summary}`).catch(() => {});
  return `Strategy for ${position.symbol} [${chain}/${position.mode}]: ${summary}`;
}

export async function exitAllPositions(): Promise<string> {
  const file = await loadPositions();
  const open = openPositions(file);
  if (!open.length) return "No open positions.";
  const lines: string[] = [];
  for (const p of open) {
    lines.push(await manualExit(p.token, 1));
  }
  return lines.join("\n");
}

/** Dashboard snapshot; `marks` carries the freshest prices from this tick. */
async function writePositionsJson(
  file: PositionsFile,
  marks: Record<string, number> = {},
): Promise<void> {
  const cfgSnapshot = loadTradeConfig();
  // Split account capital by mode: paper start (per-chain sum, paper chains only)
  // and live cash (real on-chain base-currency balance per live chain).
  let paperStartTotal = 0;
  const liveCash: Record<string, number> = {};
  for (const c of tradeEnabledChains()) {
    if (resolveTradeMode(cfgSnapshot, c) === "live") {
      const bal = await availableCapitalUsd(c, "live", cfgSnapshot, file).catch(
        () => 0,
      );
      if (Number.isFinite(bal)) liveCash[c] = bal;
    } else {
      paperStartTotal += paperStartFor(cfgSnapshot, c);
    }
  }
  // Export the full ledger (both paper and live) so the dashboard can filter
  // and paginate client-side; a fixed tail like slice(-50) silently dropped
  // whichever mode wasn't trading recently (paper vanished once live took over).
  const rows = file.positions.map((p) => {
    const mark = marks[p.token.toLowerCase()];
    return {
      chain: p.chain ?? "robinhood",
      symbol: p.symbol,
      token: p.token,
      mode: p.mode,
      status: p.status,
      trigger: p.trigger,
      opened_at: p.openedAt,
      closed_at: p.closedAt,
      entry_price_usd: p.entryPriceUsd,
      entry_fdv_usd: p.entryFdvUsd,
      current_price_usd: mark,
      remaining_fraction: remainingFraction(p),
      cost_usd: p.costUsd,
      pnl_usd: totalPnlUsd(p, mark),
      strategy: p.strategy ? formatStrategy(p.strategy) : undefined,
      amount_tokens: p.amountTokens,
      high_water_usd: p.highWaterUsd,
      // Full exit timeline so the dashboard can draw the realized equity
      // curve and per-trade breakdowns client-side.
      exits: p.exits.map((e) => ({
        at: e.at,
        price_usd: e.priceUsd,
        fraction: e.fraction,
        proceeds_usd: e.proceedsUsd,
        reason: e.reason,
      })),
    };
  });
  const payload = JSON.stringify(
    {
      meta: {
        updated_at: new Date().toISOString(),
        count: rows.length,
        start_usd: cfgSnapshot.paperStartUsd,
        // Per-chain trade mode so the dashboard can show a real/paper banner.
        trade: {
          default_mode: cfgSnapshot.mode,
          chains: cfgSnapshot.chainModes,
          router: cfgSnapshot.router,
          usd_per_trade: cfgSnapshot.usdPerTrade,
          size_pct: cfgSnapshot.sizePct,
          paper_starts: cfgSnapshot.paperStarts,
          paper_start_total: paperStartTotal,
          live_cash: liveCash,
        },
      },
      positions: rows,
    },
    null,
    2,
  );
  await mkdir(path.dirname(POSITIONS_WEB_PATH), { recursive: true });
  await writeFile(POSITIONS_WEB_PATH, payload, "utf8").catch((err) =>
    console.error("failed to write positions.json:", (err as Error).message),
  );
}

/** Paper fills happen here; live fills route to the chain adapter. */
async function executeBuy(
  chain: ChainId,
  config: TradeConfig,
  token: string,
  priceUsd: number,
  usd: number,
): Promise<TradeFill> {
  if (config.mode === "paper") {
    return { priceUsd, amountTokens: usd / priceUsd };
  }
  const adapter = getAdapter(chain);
  if (!adapter.buy) {
    throw new Error(`live execution not implemented on ${chain}`);
  }
  return adapter.buy(token, priceUsd, usd, config);
}

async function executeSell(
  chain: ChainId,
  config: TradeConfig,
  position: Position,
  fraction: number,
  currentPriceUsd: number,
): Promise<TradeFill> {
  if (config.mode === "paper") {
    const amountTokens = position.amountTokens * fraction;
    return {
      priceUsd: currentPriceUsd,
      amountTokens,
      proceedsUsd: amountTokens * currentPriceUsd,
    };
  }
  const adapter = getAdapter(chain);
  if (!adapter.sell) {
    throw new Error(`live execution not implemented on ${chain}`);
  }
  return adapter.sell(position, fraction, currentPriceUsd, config);
}

/** Attempt entries for qualifying signal evaluations. */
export async function processSignals(
  evaluations: SignalEvaluation[],
  options: EngineOptions = {},
  config: TradeConfig = loadTradeConfig(),
): Promise<Position[]> {
  if (!tradingActive(config)) return [];
  if (!config.autoEntry) {
    // AI decider owns entries — mechanical auto-entry would override its
    // skip decisions (it bought "I" 1 min after the decider said skip).
    return [];
  }
  if (tradingPaused()) {
    console.log("trading paused — skipping entries (exits still active)");
    return [];
  }
  const file = await loadPositions();
  const opened: Position[] = [];

  for (const ev of evaluations) {
    const chain = (ev.input.chain ?? "robinhood") as ChainId;
    // Chain-scoped config: this chain's mode (off skips it entirely).
    const chainMode = resolveTradeMode(config, chain);
    if (chainMode === "off") continue;
    const cfg: TradeConfig = { ...config, mode: chainMode };
    const candidate = {
      token: ev.input.address,
      chain,
      symbol: ev.input.symbol,
      priceUsd: ev.input.priceUsd,
      liquidityUsd: ev.input.liquidityUsd,
      triggers: ev.triggers,
    };
    const verdict = checkEntry(cfg, file, candidate);
    if (!verdict.ok) {
      if (verdict.reason !== "no qualifying entry trigger") {
        console.log(`entry skipped ${ev.input.symbol}: ${verdict.reason}`);
      }
      continue;
    }

    if (safetyGateEnabled()) {
      const safety = await checkTokenSafety(
        chain,
        candidate.token,
        ev.input.primaryPairAddress,
      );
      if (!safety.ok) {
        console.log(
          `entry vetoed ${ev.input.symbol} [${chain}]: ${safety.flags.join(", ")}`,
        );
        await appendTradeJournal(
          `🛑 否决入场 ${ev.input.symbol} [${chain}] — ${safety.flags.join(", ")} (triggers: ${ev.triggers.join(",")})`,
        );
        await notify(
          `🛑 ${modeTag(cfg)} entry VETOED [${chain}] ${candidate.symbol}: ${safety.flags.join(", ")}` +
            (gmgnLink(chain, candidate.token) ? `\n${gmgnLink(chain, candidate.token)}` : ""),
          options,
          chain,
          candidate.token,
        );
        continue;
      }
    }

    try {
      const fill = await executeBuy(
        chain,
        cfg,
        candidate.token,
        candidate.priceUsd!,
        cfg.usdPerTrade,
      );
      const position: Position = {
        id: `${candidate.token.toLowerCase()}-${Date.now()}`,
        mode: cfg.mode,
        chain,
        token: candidate.token,
        symbol: candidate.symbol,
        trigger: ev.triggers.join(","),
        openedAt: new Date().toISOString(),
        entryPriceUsd: fill.priceUsd,
        entryFdvUsd: ev.input.fdvUsd,
        amountTokens: fill.amountTokens,
        costUsd: cfg.usdPerTrade,
        highWaterUsd: fill.priceUsd,
        exits: [],
        status: "open",
        txHash: fill.txHash,
      };
      file.positions.push(position);
      opened.push(position);
      await appendTradeJournal(
        `📥 开仓 ${position.symbol} [${chain}/${cfg.mode}] $${cfg.usdPerTrade} @ $${fill.priceUsd.toPrecision(4)} (${fill.amountTokens.toFixed(2)} 枚) — 触发: ${position.trigger} | 策略: ${formatStrategy(position.strategy)}${fill.txHash ? ` tx:${fill.txHash}` : ""}`,
      );
      await notify(
        fillMessage({
          modeText: modeTag(cfg),
          side: "in",
          symbol: position.symbol ?? position.token,
          chain,
          token: position.token,
          fdvUsd: ev.input.fdvUsd,
          entryPriceUsd: fill.priceUsd,
          costUsd: cfg.usdPerTrade,
          amountTokens: fill.amountTokens,
          reason: `触发 ${position.trigger}`,
          follow: `策略: ${formatStrategy(position.strategy)}`,
          txHash: fill.txHash,
        }),
        options,
        chain,
        position.token,
      );
    } catch (err) {
      console.error(`entry failed ${candidate.symbol}:`, (err as Error).message);
      await notify(
        `⚠️ ${modeTag(cfg)} entry FAILED for ${candidate.symbol}: ${(err as Error).message}` +
          (gmgnLink(chain, candidate.token) ? `\n${gmgnLink(chain, candidate.token)}` : ""),
        options,
        chain,
        candidate.token,
      );
    }
  }

  if (opened.length) {
    // New entries merge into FRESH ledger state under the lock — a plain save
    // of our snapshot would erase any exits recorded by other writers while
    // this (slow, price-fetching) scan ran.
    const { file: freshFile } = await mutatePositions((f) => {
      f.positions.push(...opened);
    });
    await writePositionsJson(freshFile);
  }
  return opened;
}

/** Refresh prices for open positions, update high-water marks, run exits. */
export async function managePositions(
  options: EngineOptions = {},
  config: TradeConfig = loadTradeConfig(),
): Promise<void> {
  if (!tradingActive(config)) return;
  const file = await loadPositions();
  const open = openPositions(file);
  // Snapshot each position's exit count so only THIS tick's exits are replayed
  // onto fresh ledger state at the end — the tick is slow (per-position price
  // fetches, minutes under 429 storms) and a whole-file save of this stale
  // snapshot kept clobbering concurrent CLI trades (2026-09-04 ×3).
  const exitCountBefore = new Map(open.map((p) => [p.id, p.exits.length]));
  if (!open.length) return;
  const marks: Record<string, number> = {};

  // Batch price prefetch: one /tokens/{a,b,…} call per 25 positions instead of
  // one call each. Per-position fetches were the engine's main contribution to
  // the DexScreener 429 storms (841 rate-limit hits on 09-05 alone), which
  // stretched 15s ticks to minutes and delayed stop execution. Falls back to
  // the per-position fetch below when a token is missing from the batch.
  const prefetched = new Map<string, DexPair[]>();
  for (let i = 0; i < open.length; i += 25) {
    const chunk = open.slice(i, i + 25);
    try {
      const res = await fetchDexJson<{ pairs?: DexPair[] }>(
        `/latest/dex/tokens/${chunk.map((p) => p.token).join(",")}`,
      );
      for (const pair of res.pairs ?? []) {
        const key = pair.baseToken?.address?.toLowerCase();
        if (!key) continue;
        const list = prefetched.get(key) ?? [];
        list.push(pair);
        prefetched.set(key, list);
      }
      for (const p of chunk) {
        if (!prefetched.has(p.token.toLowerCase())) prefetched.set(p.token.toLowerCase(), []);
      }
    } catch {
      /* batch failed — the per-position path below covers this chunk */
    }
  }

  for (const position of open) {
    const chain = positionChain(position.chain);
    // Exit in the mode the position was OPENED in — a live RB position must
    // sell live even if the global default (or another chain) is paper.
    const pcfg: TradeConfig = { ...config, mode: position.mode };
    let price: number | undefined;
    let volume24hUsd: number | undefined;
    let priceChange24h: number | undefined;
    let fdvUsd: number | undefined;
    try {
      const cached = prefetched.get(position.token.toLowerCase());
      const pairs =
        cached && cached.length
          ? cached.filter((p) => p.chainId === chain)
          : await fetchTokenPairs(position.token, chain);
      const primary = selectDeepestBasePair(pairs, position.token);
      if (primary?.priceUsd) price = Number(primary.priceUsd);
      volume24hUsd = Number(primary?.volume?.h24 ?? 0) || undefined;
      priceChange24h = primary?.priceChange?.h24;
      fdvUsd = primary?.fdv;
    } catch (err) {
      console.error(`price fetch failed ${position.symbol}:`, (err as Error).message);
    }
    if (price == null || price <= 0) {
      // DexScreener outage must not blind the stops — fall back to DexPaprika.
      try {
        price = await fetchPaprikaTokenPriceUsd(chain, position.token);
        if (price) console.log(`using DexPaprika fallback price for ${position.symbol}`);
      } catch {}
    }
    if (price == null || price <= 0) continue;

    // Glitch guard: a >65% single-tick collapse below the high-water mark is
    // almost always a bad read (a degraded DexScreener response drops the deep
    // pair's liquidity to null→0, so a thin wrong-pair with a garbage price
    // ranks first), not real action on a token that had real liquidity. No
    // configured stop is that deep, so this can only be noise or a true rug —
    // and both deserve a second look before we market-sell the whole position.
    // memestock was hard-stopped at $0.0077 (140x below its $1.08 entry, −$139)
    // on ONE garbage tick while the real price never left ~$1. Corroborate with
    // a fresh read; a genuine rug still exits one tick (~15s) later once the low
    // price is confirmed, but a transient glitch no longer liquidates the book.
    // Both directions route through the SAME two-independent-source check
    // (decideExtremePrice): the old inline downside confirm re-read DexScreener
    // first and trusted whatever it said — a degraded response confirmed its
    // own garbage and OPTIMUS was "hard stopped" at real÷7.3 eleven seconds
    // after entry (2026-09-04 12:27) while the token never fell. Now an
    // extreme read trades only when DexScreener-consensus AND DexPaprika both
    // independently agree it is real; an in-band source corrects the read; no
    // agreement = skip the tick (a true rug exits next tick).
    {
      const decided = await corroboratePrice(position, chain, price);
      if (decided == null) {
        console.error(
          `glitch guard: ${position.symbol} unconfirmed extreme tick $${price} ` +
            `(hw $${position.highWaterUsd}) — skipping this tick`,
        );
        continue;
      }
      if (decided !== price) {
        console.error(
          `glitch guard: ${position.symbol} bad tick $${price} → corrected $${decided} ` +
            `(hw $${position.highWaterUsd})`,
        );
        price = decided;
      }
    }

    marks[position.token.toLowerCase()] = price;

    // Live dust: routers have a minimum trade size, so a tiny remainder can
    // NEVER be sold on-chain — WALLET's staged live exit left 2% (~$0.7) that
    // every later mechanical exit retried and failed forever ("no v3 route").
    // Write it off as closed (tokens stay in the wallet, proceeds 0) instead
    // of spinning the exit engine on an unsellable crumb.
    const remainingValueUsd =
      remainingFraction(position) * position.amountTokens * price;
    if (position.mode === "live" && remainingValueUsd > 0 && remainingValueUsd < 1.5) {
      recordExit(position, {
        at: new Date().toISOString(),
        priceUsd: price,
        fraction: remainingFraction(position),
        proceedsUsd: 0,
        reason: "dust write-off: remainder below router minimum (tokens remain in wallet)",
      });
      await appendTradeJournal(
        `🧹 尘埃核销 ${position.symbol} [${chain}/live] 剩余 ~$${remainingValueUsd.toFixed(2)} 低于路由最小额,记为 closed(代币留在钱包)`,
      );
      continue;
    }

    position.highWaterUsd = Math.max(position.highWaterUsd, price);
    const actions: ExitAction[] = evaluateExits(position, price, config);

    // Optional LLM advisor: may recommend an EARLY exit when the deterministic
    // rails haven't fired; it can never cancel or delay them.
    if (
      !actions.length &&
      advisorAvailable() &&
      (!position.lastAdvisorAt ||
        Date.now() - new Date(position.lastAdvisorAt).getTime() >
          ADVISOR_COOLDOWN_MS)
    ) {
      position.lastAdvisorAt = new Date().toISOString();
      const decision = await adviseExit(position, {
        currentPriceUsd: price,
        volume24hUsd,
        priceChange24h,
      });
      if (decision.action === "exit" && decision.confidence >= 0.6) {
        actions.push({
          fraction: remainingFraction(position),
          reason: `advisor (${decision.confidence.toFixed(2)}): ${decision.reason}`,
        });
      }
    }

    for (const action of actions) {
      try {
        // A full-close stop is destructive and irreversible — confirm the low
        // price against fresh independent sources before liquidating, so a
        // single noise tick on a young/thin pool can't market-sell a winner
        // (see confirmStopTriggered / FARM 2026-09-05).
        if (isStopAction(action) && !(await confirmStopTriggered(position, chain, config))) {
          console.error(
            `stop guard: ${position.symbol} "${action.reason}" not confirmed by fresh ` +
              `independent read (tick $${price}) — skipping this tick`,
          );
          continue;
        }
        const fill = await executeSell(chain, pcfg, position, action.fraction, price);
        recordExit(position, {
          at: new Date().toISOString(),
          priceUsd: fill.priceUsd,
          fraction: action.fraction,
          proceedsUsd: fill.proceedsUsd ?? 0,
          reason: action.reason,
          txHash: fill.txHash,
        });
        const pnl = totalPnlUsd(position, price);
        await appendTradeJournal(
          `📤 平仓 ${position.symbol} [${chain}/${pcfg.mode}] 卖出 ${(action.fraction * 100).toFixed(0)}% @ $${fill.priceUsd.toPrecision(4)} → $${(fill.proceedsUsd ?? 0).toFixed(2)} — 原因: ${action.reason} | 持仓盈亏 ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${position.status}) | 策略: ${formatStrategy(position.strategy)}`,
        );
        await notify(
          fillMessage({
            modeText: modeTag(pcfg),
            side: "out",
            symbol: position.symbol ?? position.token,
            chain,
            token: position.token,
            fdvUsd,
            fraction: action.fraction,
            entryPriceUsd: position.entryPriceUsd,
            exitPriceUsd: fill.priceUsd,
            proceedsUsd: fill.proceedsUsd ?? 0,
            thisRealizedUsd: (fill.proceedsUsd ?? 0) - action.fraction * position.costUsd,
            positionPnlUsd: pnl,
            statusText:
              position.status === "closed"
                ? "closed"
                : `open 剩${(remainingFraction(position) * 100).toFixed(0)}%`,
            reason: `机械出场 — ${action.reason}`,
            follow:
              position.status === "closed"
                ? "后续: 已清仓，停止跟踪"
                : `策略: ${formatStrategy(position.strategy)}`,
            txHash: fill.txHash,
          }),
          options,
          chain,
          position.token,
        );
      } catch (err) {
        console.error(`exit failed ${position.symbol}:`, (err as Error).message);
        // A live exit failing is REAL money that cannot leave the market —
        // GRASS's 1.35x take-profit spun for 18+ minutes of silent per-tick
        // "no v3 route" failures (v4-pool token, sub-minimum size) before a
        // review round noticed. Surface it loudly, throttled per position.
        if (pcfg.mode === "live") {
          const key = position.id;
          const last = liveExitFailNotifiedAt.get(key) ?? 0;
          if (Date.now() - last > 30 * 60_000) {
            liveExitFailNotifiedAt.set(key, Date.now());
            await notify(
              `🚨 LIVE 出场失败 **${position.symbol}** [${chain}] — ${action.reason}\n` +
                `错误: ${(err as Error).message.slice(0, 180)}\n` +
                `仓位卖不出去(疑似 v4 池无 v3 路由/低于路由最小额),止盈止损均在空转——需要 live 路由侧处理`,
              options,
              chain,
              position.token,
            );
          }
        }
      }
    }
    await sleep(250);
  }

  // Replay this tick's deltas (high-water, advisor timestamps, new exits)
  // onto FRESH ledger state under the lock. Exits computed against our
  // snapshot are clamped to what actually remains — if a CLI sell landed
  // mid-tick, we neither resurrect the position nor double-sell it.
  const dayMs = 24 * 60 * 60 * 1000;
  const { file: freshFile, result: dueDailyReport } = await mutatePositions(
    (fresh) => {
      for (const position of open) {
        const fp = fresh.positions.find((p) => p.id === position.id);
        if (!fp) continue;
        fp.highWaterUsd = Math.max(fp.highWaterUsd, position.highWaterUsd);
        if (position.lastAdvisorAt) fp.lastAdvisorAt = position.lastAdvisorAt;
        const newExits = position.exits.slice(exitCountBefore.get(position.id) ?? 0);
        for (const e of newExits) {
          if (fp.status !== "open") break;
          mergeExitIntoFresh(fp, e);
        }
      }
      const due =
        fresh.positions.length > 0 &&
        (!fresh.lastReportAt ||
          Date.now() - new Date(fresh.lastReportAt).getTime() > dayMs);
      if (due) fresh.lastReportAt = new Date().toISOString();
      return due;
    },
  );
  await writePositionsJson(freshFile, marks);

  if (dueDailyReport) {
    await notify(`📊 **现货 Daily P&L**\n${await formatPortfolioReport()}`, options);
  }
}

export async function formatPortfolioReport(): Promise<string> {
  const file = await loadPositions();
  const config = loadTradeConfig();
  // Sum paper capital across all trade-enabled chains (each with its own start).
  const paperChains = tradeEnabledChains();
  const start = paperChains.reduce((s, c) => s + paperStartFor(config, c), 0);
  const cash = paperChains.reduce(
    (s, c) => s + paperCashUsd(file, paperStartFor(config, c), c),
    0,
  );

  // 措辞/结构对齐永续 formatPerpReport,两条 trade-log 消息长得一样。
  const lines: string[] = [];
  const open = openPositions(file);
  let openValue = 0;
  if (open.length) {
    lines.push(`**现货持仓 (${open.length})**`);
    for (const p of open) {
      const chain = positionChain(p.chain);
      let price: number | undefined;
      let fdvUsd: number | undefined;
      try {
        const primary = selectDeepestBasePair(await fetchTokenPairs(p.token, chain), p.token);
        if (primary?.priceUsd) price = Number(primary.priceUsd);
        fdvUsd = primary?.fdv;
      } catch {}
      if (price == null) {
        try {
          price = await getAdapter(chain).priceUsd(p.token);
        } catch {}
      }
      const pnl = totalPnlUsd(p, price);
      const rem = remainingFraction(p);
      // Paper equity only sums paper positions; live positions are settled by
      // the on-chain wallet, shown here for visibility but not in paper cash.
      if (p.mode === "paper") {
        openValue += rem * p.amountTokens * (price ?? p.entryPriceUsd);
      }
      lines.push(
        `• 🟢 ${p.symbol ?? p.token} [${chain}/${p.mode}] ${(rem * 100).toFixed(0)}% 剩, ` +
          `开 $${p.entryPriceUsd.toPrecision(6)}${price ? ` 现 $${price.toPrecision(6)}` : ""}${fdvTag(fdvUsd)}, ` +
          `盈亏 ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` +
          (p.strategy ? `\n    ↳ 策略: ${formatStrategy(p.strategy)}` : ""),
      );
      await sleep(200);
    }
  } else {
    lines.push("无现货持仓");
  }

  const closed = file.positions.filter((p) => p.status === "closed");
  if (closed.length) {
    const realized = closed.reduce((s, p) => s + realizedUsd(p) - p.costUsd, 0);
    lines.push(
      `**已平: ${closed.length} 笔, 已实现盈亏 ${realized >= 0 ? "+" : ""}$${realized.toFixed(2)}**`,
    );
  }

  // Paper account balance — the number the strategy is judged against.
  const equity = cash + openValue;
  const pnl = equity - start;
  const pct = (pnl / start) * 100;
  lines.push(
    `**💰 现货 paper 账户 $${equity.toFixed(2)}** ` +
      `(起始 $${start.toFixed(0)} · ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} / ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%) — ` +
      `可用现金 $${cash.toFixed(2)}${openValue > 0 ? ` · 持仓市值 $${openValue.toFixed(2)}` : ""}`,
  );
  return lines.join("\n");
}
