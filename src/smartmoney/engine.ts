import { sendDiscordEmbed, sendDiscordMessage } from "../notify/discord.js";
import { resolveWebhook } from "../notify/routes.js";
import { appendAiInboxNews } from "../notify/ai-inbox.js";
import { appendSmLog } from "./log.js";
import { resolveFilter } from "./config.js";

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

    // --- AI-trigger gate (strict). Solo-trigger wallets bypass conviction. ---
    const bigEnough = (buy.usd ?? Infinity) >= filter.aiMinUsd;
    const meets =
      bigEnough &&
      (filter.soloTrigger || distinct >= filter.aiConvictionN);
    if (meets) await this.escalate(buy, distinct, filter.aiWindowMin);
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
    const description = [
      `\`${buy.walletLabel}\` 买入 **$${buy.symbol}**${usdStr}`,
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
    windowMin: number,
  ): Promise<void> {
    const key = `${buy.chain.toLowerCase()}:${buy.token.toLowerCase()}`;
    const last = this.escalated.get(key) ?? 0;
    if (buy.ts - last < windowMin * 60_000) return; // one signal per token/window
    this.escalated.set(key, buy.ts);

    const style = chainStyle(buy.chain);
    const link = this.tokenLink(buy.chain, buy.token);
    const usdStr = buy.usd ? ` (~$${Math.round(buy.usd).toLocaleString()})` : "";

    // 1) Trade signal → the chain's signal channel (a decision is requested).
    const signal = [
      `🎯 **交易信号 / TRADE SIGNAL** · ${style.emoji} ${style.name}`,
      `聪明钱驱动:窗口内 **${distinct}** 个追踪钱包买入 **$${buy.symbol}**${usdStr}`,
      `最近:\`${buy.walletLabel}\``,
      `CA: \`${buy.token}\``,
      `🔗 <${link}>`,
      `🤖 已唤醒 AI 决策 —— 待定买入/跳过`,
    ].join("\n");
    const signalHook = resolveWebhook("signal", buy.chain);
    if (signalHook) {
      await sendDiscordMessage(signalHook, signal).catch((err) =>
        console.error("smart-money trade-signal failed:", (err as Error).message),
      );
    }

    // 2) Wake the AI decision layer (writes inbox; spawns decider if keyed).
    await appendAiInboxNews({
      title: `🎯 交易信号:${distinct} 个聪明钱买入 $${buy.symbol} [${buy.chain}] — 需决策`,
      url: link,
      reasons: [
        `smart-money trade signal: ${distinct} tracked wallets bought ${buy.token} on ${buy.chain} within ${windowMin}min${usdStr}. Decide buy or skip.`,
      ],
      negative: false,
      note: `CA ${buy.token}`,
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

    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const { maybeSpawnDecider } = await import("../trade/decider.js");
        void maybeSpawnDecider("signal");
      } catch (err) {
        console.error("smart-money decider spawn failed:", (err as Error).message);
      }
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
      reason: process.env.ANTHROPIC_API_KEY ? "trade-signal+ai-woken" : "trade-signal (ai-key-missing)",
    });
    console.log(`[smart-money] TRADE SIGNAL $${buy.symbol} [${buy.chain}] → ${style.name} channel`);
  }
}

/** Shared singleton so all watchers share one conviction window + dedup set. */
export const smartMoneyEngine = new SmartMoneyEngine();
