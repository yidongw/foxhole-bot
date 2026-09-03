import { sendDiscordMessage } from "../notify/discord.js";
import { resolveWebhook } from "../notify/routes.js";
import { appendAiInboxNews } from "../notify/ai-inbox.js";
import { ConvictionTracker } from "../chains/robinhood/smart-money.js";
import { appendSmLog } from "./log.js";

/**
 * Chain-agnostic smart-money buy handler. Both the RB on-chain wss watcher and
 * the GMGN activity poller (bsc/sol/…) funnel every detected buy through
 * `handleBuy`, so filtering, alerting, conviction and AI escalation behave
 * identically across chains.
 *
 * Two filter levels (your spec):
 *   - Alert filter (loose): min USD; dedup — decides what hits Discord.
 *   - AI-trigger filter (strict): ≥N distinct wallets in-window AND combined
 *     USD ≥ threshold — decides what wakes the AI analysis layer + signals.
 */

export interface SmartMoneyBuy {
  chain: string;
  wallet: string;
  walletLabel: string;
  token: string;
  symbol: string;
  /** USD size of the buy (may be undefined if unpriced). */
  usd?: number;
  txHash: string;
  ts: number;
  source: string; // "rpc" | "gmgn"
}

const num = (k: string, d: number) => Number(process.env[k] ?? d);

export class SmartMoneyEngine {
  private conviction = new ConvictionTracker(num("SMART_MONEY_WINDOW_MIN", 60) * 60_000);
  private alerted = new Set<string>(); // txHash:wallet:token
  private escalated = new Map<string, number>(); // chain:token -> last escalate ts

  private readonly minUsd = num("SMART_MONEY_MIN_USD", 0);
  private readonly convictionN = num("SMART_MONEY_CONVICTION_N", 2);
  private readonly windowMin = num("SMART_MONEY_WINDOW_MIN", 60);
  private readonly aiMinUsd = num("SMART_MONEY_AI_MIN_USD", 0);

  async handleBuy(buy: SmartMoneyBuy): Promise<void> {
    const dedup = `${buy.txHash}:${buy.wallet.toLowerCase()}:${buy.token.toLowerCase()}`;
    if (this.alerted.has(dedup)) return;
    this.alerted.add(dedup);
    if (this.alerted.size > 8000) this.alerted.clear();

    // --- Alert filter (loose) ---
    if (this.minUsd > 0 && (buy.usd ?? 0) < this.minUsd) {
      await appendSmLog({
        kind: "skipped",
        chain: buy.chain,
        wallet: buy.wallet,
        walletLabel: buy.walletLabel,
        token: buy.token,
        symbol: buy.symbol,
        usd: buy.usd,
        txHash: buy.txHash,
        reason: `below min USD ${this.minUsd}`,
      });
      return;
    }

    const distinct = this.conviction.record(buy.token, buy.wallet, buy.ts);
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

    // --- AI-trigger filter (strict) ---
    const bigEnough = (buy.usd ?? 0) >= this.aiMinUsd;
    if (distinct >= this.convictionN && bigEnough) {
      await this.escalate(buy, distinct);
    }
  }

  private tokenLink(chain: string, token: string): string {
    if (chain === "robinhood") {
      return `https://robinhoodchain.blockscout.com/token/${token}`;
    }
    return `https://gmgn.ai/${chain}/token/${token}`;
  }

  private async alert(buy: SmartMoneyBuy, distinct: number): Promise<void> {
    const usdStr = buy.usd ? ` (~$${Math.round(buy.usd).toLocaleString()})` : "";
    const lines = [
      `🐳 **聪明钱买入 / SMART MONEY BUY** [${buy.chain}]`,
      `\`${buy.walletLabel}\` 买入 **$${buy.symbol}**${usdStr}`,
      `窗口内 **${distinct}** 个追踪钱包买入 $${buy.symbol}`,
      `CA: \`${buy.token}\``,
      `👛 \`${buy.wallet}\``,
      `🔗 <${this.tokenLink(buy.chain, buy.token)}>`,
    ];
    const webhook =
      resolveWebhook("smartmoney", buy.chain) ?? resolveWebhook("signal", buy.chain);
    if (webhook) {
      await sendDiscordMessage(webhook, lines.join("\n")).catch((err) =>
        console.error("smart-money alert failed:", (err as Error).message),
      );
    }
    console.log(
      `[smart-money] ${buy.chain} ${buy.walletLabel} bought ${buy.symbol} (${distinct} in window)`,
    );
  }

  private async escalate(buy: SmartMoneyBuy, distinct: number): Promise<void> {
    const key = `${buy.chain}:${buy.token.toLowerCase()}`;
    const last = this.escalated.get(key) ?? 0;
    if (buy.ts - last < this.windowMin * 60_000) return; // debounce per window
    this.escalated.set(key, buy.ts);

    await appendAiInboxNews({
      title: `🐳 ${distinct} 个聪明钱钱包买入 $${buy.symbol} [${buy.chain}]`,
      url: this.tokenLink(buy.chain, buy.token),
      reasons: [
        `smart-money conviction: ${distinct} tracked wallets bought ${buy.token} on ${buy.chain} within ${this.windowMin}min`,
      ],
      negative: false,
      note: `CA ${buy.token}`,
    }).catch((err) =>
      console.error("smart-money inbox failed:", (err as Error).message),
    );

    // RB tokens ride the existing v4 discovery watchlist so每 tick 分析 picks
    // them up; other chains rely on the AI inbox wake alone.
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

    // Wake the AI decision layer (no-op / logs if ANTHROPIC_API_KEY unset).
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
      reason: process.env.ANTHROPIC_API_KEY ? "ai-woken" : "ai-key-missing",
    });
    console.log(`[smart-money] escalated $${buy.symbol} [${buy.chain}] to signals`);
  }
}

/** Shared singleton so all watchers share one conviction window + dedup set. */
export const smartMoneyEngine = new SmartMoneyEngine();
