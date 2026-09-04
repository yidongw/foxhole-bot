import { sendDiscordEmbed, sendDiscordMessage } from "../notify/discord.js";
import { resolveWebhook } from "../notify/routes.js";
import { appendAiInboxSmartMoney } from "../notify/ai-inbox.js";
import { ensureSignalThread } from "../notify/signal-threads.js";
import { canonicalChain } from "../chains/robinhood/smart-money.js";
import { appendSmLog } from "./log.js";
import { resolveFilter, type SmartMoneyFilter } from "./config.js";
import { fdvTag } from "../lib/format.js";

/** Best-liquidity market snapshot for a token (DexScreener), or undefined. */
async function fetchTokenMarket(
  chain: string,
  token: string,
): Promise<{ liquidityUsd: number; h1: number; h24: number; fdvUsd?: number } | undefined> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, {
      headers: { "User-Agent": "foxhole-bot/0.3" },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      pairs?: Array<{
        chainId?: string;
        liquidity?: { usd?: number };
        priceChange?: { h1?: number; h24?: number };
        fdv?: number;
      }>;
    };
    const pairs = (data.pairs ?? []).filter((p) => p.chainId === chain);
    if (!pairs.length) return undefined;
    const best = pairs.reduce((a, b) =>
      (b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a,
    );
    return {
      liquidityUsd: Number(best.liquidity?.usd ?? 0),
      h1: Number(best.priceChange?.h1 ?? 0),
      h24: Number(best.priceChange?.h24 ?? 0),
      fdvUsd: Number(best.fdv) || undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Chain-agnostic smart-money buy handler. Both the RB on-chain wss watcher and
 * the GMGN/Cielo feeds funnel every detected buy through `handleBuy`, so
 * filtering, alerting, conviction and AI escalation behave identically.
 *
 * Two outcomes (per your spec):
 *   - ALERT (informational): a qualifying buy → color-coded embed in the
 *     smart-money channel. No decision required.
 *   - TRADE SIGNAL (decision required): when the per-chain AI-trigger gate is
 *     met → a trade signal is posted to that chain's signal channel AND the AI
 *     decision layer is woken to decide buy / skip.
 *
 * Gates are resolved per (chain, wallet) from smart-money-config.ts, so each
 * address can carry its own thresholds and each chain its own AI conditions.
 */

export interface SmartMoneyBuy {
  chain: string;
  wallet: string;
  walletLabel: string;
  token: string;
  symbol: string;
  usd?: number;
  txHash: string;
  ts: number;
  source: string; // "rpc" | "gmgn" | "cielo"
  /** Quality tier from the winner-finder; "S" acts as a solo trigger. */
  tier?: string;
}

/** Per-chain brand color (embed border) + emoji, so alerts are distinguishable. */
const CHAIN_STYLE: Record<string, { color: number; emoji: string; name: string }> = {
  robinhood: { color: 0x00c805, emoji: "🟢", name: "RB" },
  bsc: { color: 0xf0b90b, emoji: "🟡", name: "BSC" },
  solana: { color: 0x9945ff, emoji: "🟣", name: "SOL" },
  sol: { color: 0x9945ff, emoji: "🟣", name: "SOL" },
  base: { color: 0x0052ff, emoji: "🔵", name: "BASE" },
  ethereum: { color: 0x627eea, emoji: "⚪", name: "ETH" },
  eth: { color: 0x627eea, emoji: "⚪", name: "ETH" },
};
const chainStyle = (c: string) =>
  CHAIN_STYLE[c.toLowerCase()] ?? { color: 0x808080, emoji: "⚫", name: c.toUpperCase() };

interface RecentBuy {
  wallet: string;
  ts: number;
}

export class SmartMoneyEngine {
  private recent = new Map<string, RecentBuy[]>(); // chain:token -> buys
  private alerted = new Set<string>(); // txHash:wallet:token
  private cooldown = new Map<string, number>(); // chain:wallet:token -> last alert ts
  private escalated = new Map<string, number>(); // chain:token -> last escalate ts

  /** Distinct tracked wallets that bought this token within the window. */
  private recordAndCount(
    key: string,
    wallet: string,
    ts: number,
    windowMs: number,
  ): number {
    const cutoff = ts - windowMs;
    const arr = (this.recent.get(key) ?? []).filter((e) => e.ts > cutoff);
    arr.push({ wallet: wallet.toLowerCase(), ts });
    this.recent.set(key, arr);
    return new Set(arr.map((e) => e.wallet)).size;
  }

  async handleBuy(buy: SmartMoneyBuy): Promise<void> {
    // Normalise chain to the canonical routing name (sol→solana, eth→ethereum)
    // so webhooks, signal channels and thread keys line up with the rest of the bot.
    buy = { ...buy, chain: canonicalChain(buy.chain) };
    const dedup = `${buy.txHash}:${buy.wallet.toLowerCase()}:${buy.token.toLowerCase()}`;
    if (this.alerted.has(dedup)) return;
    this.alerted.add(dedup);
    if (this.alerted.size > 8000) this.alerted.clear();

    const filter = await resolveFilter(buy.chain, buy.wallet);

    // --- Alert gate (loose). Unpriced buys (usd undefined) always pass. ---
    if (filter.alertMinUsd > 0 && buy.usd !== undefined && buy.usd < filter.alertMinUsd) {
      await appendSmLog({
        kind: "skipped",
        chain: buy.chain,
        wallet: buy.wallet,
        walletLabel: buy.walletLabel,
        token: buy.token,
        symbol: buy.symbol,
        usd: buy.usd,
        txHash: buy.txHash,
        reason: `below alert min $${filter.alertMinUsd}`,
      });
      return;
    }

    // --- Per-(wallet,token) cooldown: silence a wallet re-buying the same token. ---
    if (filter.alertCooldownMin > 0) {
      const cdKey = `${buy.chain.toLowerCase()}:${buy.wallet.toLowerCase()}:${buy.token.toLowerCase()}`;
      const lastCd = this.cooldown.get(cdKey) ?? 0;
      if (buy.ts - lastCd < filter.alertCooldownMin * 60_000) return; // silent skip
      this.cooldown.set(cdKey, buy.ts);
      if (this.cooldown.size > 8000) this.cooldown.clear();
    }

    const key = `${buy.chain.toLowerCase()}:${buy.token.toLowerCase()}`;
    const distinct = this.recordAndCount(
      key,
      buy.wallet,
      buy.ts,
      filter.aiWindowMin * 60_000,
    );
    await this.alert(buy, distinct);
    await appendSmLog({
      kind: "alert",
      chain: buy.chain,
      wallet: buy.wallet,
      walletLabel: buy.walletLabel,
      token: buy.token,
      symbol: buy.symbol,
      usd: buy.usd,
      txHash: buy.txHash,
      distinct,
    });

    // --- AI-trigger gate (strict). Solo-trigger (config or tier-S) bypasses conviction. ---
    const bigEnough = (buy.usd ?? Infinity) >= filter.aiMinUsd;
    const solo = filter.soloTrigger || buy.tier === "S";
    const meets = bigEnough && (solo || distinct >= filter.aiConvictionN);
    if (meets) await this.escalate(buy, distinct, filter);
  }

  /**
   * Anti-chase gate: skip waking the AI when the token is too thin to copy or
   * has already blown off (we'd be buying the top — the 事后 problem). Runs one
   * DexScreener call, only on escalation (rare), so latency is fine. Fail-open:
   * if market data is unavailable, don't block the signal.
   */
  private async antiChaseSkip(
    buy: SmartMoneyBuy,
    filter: SmartMoneyFilter,
  ): Promise<string | undefined> {
    if (filter.aiMinLiquidityUsd <= 0 && filter.aiMaxPump1hPct <= 0 && filter.aiMaxPump24hPct <= 0)
      return undefined;
    const mkt = await fetchTokenMarket(buy.chain, buy.token);
    if (!mkt) return undefined; // fail-open
    if (filter.aiMinLiquidityUsd > 0 && mkt.liquidityUsd < filter.aiMinLiquidityUsd)
      return `liq $${Math.round(mkt.liquidityUsd).toLocaleString()} < $${filter.aiMinLiquidityUsd.toLocaleString()}`;
    if (filter.aiMaxPump1hPct > 0 && mkt.h1 > filter.aiMaxPump1hPct)
      return `1h +${Math.round(mkt.h1)}% > ${filter.aiMaxPump1hPct}% (chasing)`;
    if (filter.aiMaxPump24hPct > 0 && mkt.h24 > filter.aiMaxPump24hPct)
      return `24h +${Math.round(mkt.h24)}% > ${filter.aiMaxPump24hPct}% (post-hoc)`;
    return undefined;
  }

  private tokenLink(chain: string, token: string): string {
    if (chain === "robinhood") {
      return `https://robinhoodchain.blockscout.com/token/${token}`;
    }
    const g = chainStyle(chain).name.toLowerCase();
    return `https://gmgn.ai/${g === "rb" ? "eth" : g}/token/${token}`;
  }

  private async alert(buy: SmartMoneyBuy, distinct: number): Promise<void> {
    const style = chainStyle(buy.chain);
    const usdStr = buy.usd ? ` (~$${Math.round(buy.usd).toLocaleString()})` : "";
    const fdv = (await fetchTokenMarket(buy.chain, buy.token))?.fdvUsd;
    const description = [
      `\`${buy.walletLabel}\` 买入 **$${buy.symbol}**${usdStr}${fdvTag(fdv)}`,
      `窗口内 **${distinct}** 个追踪钱包买入 $${buy.symbol}`,
      `CA: \`${buy.token}\``,
      `👛 \`${buy.wallet}\``,
      `🔗 [查看代币](${this.tokenLink(buy.chain, buy.token)})`,
    ].join("\n");
    const webhook =
      resolveWebhook("smartmoney", buy.chain) ?? resolveWebhook("signal", buy.chain);
    if (webhook) {
      await sendDiscordEmbed(webhook, {
        title: `${style.emoji} 聪明钱买入 · ${style.name} SMART MONEY BUY`,
        description,
        color: style.color,
        footer: { text: `${style.name} · smart-money` },
      }).catch((err) =>
        console.error("smart-money alert failed:", (err as Error).message),
      );
    }
    console.log(
      `[smart-money] ${buy.chain} ${buy.walletLabel} bought ${buy.symbol} (${distinct} in window)`,
    );
  }

  /** Decision-required: post a trade signal to the chain channel + wake AI. */
  private async escalate(
    buy: SmartMoneyBuy,
    distinct: number,
    filter: SmartMoneyFilter,
  ): Promise<void> {
    const windowMin = filter.aiWindowMin;
    const key = `${buy.chain.toLowerCase()}:${buy.token.toLowerCase()}`;
    const last = this.escalated.get(key) ?? 0;
    if (buy.ts - last < windowMin * 60_000) return; // one signal per token/window

    // Anti-chase: don't wake AI on thin or already-blown-off tokens (事后).
    const skip = await this.antiChaseSkip(buy, filter);
    if (skip) {
      await appendSmLog({
        kind: "skipped",
        chain: buy.chain,
        wallet: buy.wallet,
        walletLabel: buy.walletLabel,
        token: buy.token,
        symbol: buy.symbol,
        usd: buy.usd,
        txHash: buy.txHash,
        distinct,
        reason: `ai-trigger anti-chase: ${skip}`,
      });
      console.log(`[smart-money] AI trigger skipped $${buy.symbol} [${buy.chain}]: ${skip}`);
      return;
    }
    this.escalated.set(key, buy.ts);

    const style = chainStyle(buy.chain);
    const link = this.tokenLink(buy.chain, buy.token);
    const usdStr = buy.usd ? ` (~$${Math.round(buy.usd).toLocaleString()})` : "";
    const fdv = (await fetchTokenMarket(buy.chain, buy.token))?.fdvUsd;

    // 1) Trade signal → the chain's signal channel (a decision is requested).
    const signal = [
      `🎯 **交易信号 / TRADE SIGNAL** · ${style.emoji} ${style.name}`,
      `聪明钱驱动:窗口内 **${distinct}** 个追踪钱包买入 **$${buy.symbol}**${usdStr}${fdvTag(fdv)}`,
      `最近:\`${buy.walletLabel}\``,
      `CA: \`${buy.token}\``,
      `🔗 <${link}>`,
      `🤖 已唤醒 AI 决策 —— 待定买入/跳过`,
    ].join("\n");
    // Create/post the per-token thread so the AI decider's note has somewhere
    // to land; fall back to a flat message if threads aren't available here.
    const threaded = await ensureSignalThread(
      buy.chain,
      buy.token,
      buy.symbol,
      signal,
    ).catch(() => false);
    if (!threaded) {
      const signalHook = resolveWebhook("signal", buy.chain);
      if (signalHook) {
        await sendDiscordMessage(signalHook, signal).catch((err) =>
          console.error("smart-money trade-signal failed:", (err as Error).message),
        );
      }
    }

    // 2) Wake the AI decision layer as a COIN signal so the decider runs its
    //    per-token buy/skip path (live price check), not the news path.
    await appendAiInboxSmartMoney({
      chain: buy.chain,
      address: buy.token,
      symbol: buy.symbol,
      distinct,
      usd: buy.usd,
      reasons: [
        `smart-money: ${distinct} tracked wallets bought ${buy.symbol} on ${buy.chain} within ${windowMin}min${usdStr} — latest ${buy.walletLabel}. Decide buy or skip.`,
      ],
    }).catch((err) =>
      console.error("smart-money inbox failed:", (err as Error).message),
    );

    // RB tokens ride the existing v4 discovery watchlist so每 tick 分析 covers them.
    if (buy.chain === "robinhood") {
      try {
        const { loadV4Watch, saveV4Watch } = await import(
          "../chains/robinhood/v4-watcher.js"
        );
        const entries = await loadV4Watch();
        if (!entries.some((e) => e.address.toLowerCase() === buy.token.toLowerCase())) {
          entries.push({
            address: buy.token,
            firstSeen: new Date().toISOString(),
            verified: true,
            attempts: 0,
          });
          await saveV4Watch(entries);
        }
      } catch (err) {
        console.error("smart-money watchlist add failed:", (err as Error).message);
      }
    }

    // Wake the AI decision layer. This spawns a headless `claude -p` run
    // (Claude Code, OAuth) that reads the AI inbox and decides buy/skip — it
    // does NOT use ANTHROPIC_API_KEY, so it fires on every trade signal.
    try {
      const { maybeSpawnDecider } = await import("../trade/decider.js");
      void maybeSpawnDecider("signal");
    } catch (err) {
      console.error("smart-money decider spawn failed:", (err as Error).message);
    }

    await appendSmLog({
      kind: "trigger",
      chain: buy.chain,
      wallet: buy.wallet,
      walletLabel: buy.walletLabel,
      token: buy.token,
      symbol: buy.symbol,
      usd: buy.usd,
      txHash: buy.txHash,
      distinct,
      reason: "trade-signal + ai-woken",
    });
    console.log(`[smart-money] TRADE SIGNAL $${buy.symbol} [${buy.chain}] → ${style.name} channel`);
  }
}

/** Shared singleton so all watchers share one conviction window + dedup set. */
export const smartMoneyEngine = new SmartMoneyEngine();
