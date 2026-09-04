#!/usr/bin/env node
import { loadEnv } from "../lib/env.js";
loadEnv();

import { formatUnits } from "viem";
import { Connection, PublicKey } from "@solana/web3.js";

import { aiBuy, formatPortfolioReport, manualExit, setStrategy } from "../trade/engine.js";
import type { PositionStrategy } from "../trade/positions.js";
import { archiveAiInbox, readAiInbox } from "../notify/ai-inbox.js";
import { postToSignalThread } from "../notify/signal-threads.js";
import { postToNewsResearchThread } from "../notify/news-threads.js";
import { resolveWebhook } from "../notify/routes.js";
import { sendDiscordMessage } from "../notify/discord.js";
import { getEvmClient } from "../chains/evm/clients.js";
import { getPublicClient } from "../chain/client.js";
import { privateKeyToAccount } from "viem/accounts";

/**
 * AI 决策入口 — the Claude session drives trades through these commands;
 * every order passes the full risk + safety gates.
 *
 *   ai-trade inbox               读未处理信号 (JSON)
 *   ai-trade archive             信号归档 (决策完成后)
 *   ai-trade buy <chain> <address> <usd> [策略flags] <reason...>
 *   ai-trade sell <symbol|address> <percent>
 *   ai-trade strategy <symbol|address> [策略flags]   调整某仓的退出策略
 *   ai-trade note <chain> <address> <text...>   决策摘要写进该币 thread
 *   ai-trade status              仓位 + 余额 + 每仓策略
 */

async function balances(): Promise<string> {
  const lines: string[] = [];
  const pk = process.env.TRADER_PRIVATE_KEY;
  if (pk) {
    const evm = privateKeyToAccount(pk as `0x${string}`);
    lines.push(`EVM 地址: ${evm.address}`);
    for (const [chain, label] of [
      ["robinhood", "RB"],
      ["bsc", "BNB"],
      ["base", "Base ETH"],
      ["ethereum", "ETH"],
    ] as const) {
      try {
        const client = chain === "robinhood" ? getPublicClient() : getEvmClient(chain);
        const wei = await client.getBalance({ address: evm.address });
        lines.push(`  ${label}: ${Number(formatUnits(wei, 18)).toFixed(5)}`);
      } catch (err) {
        lines.push(`  ${label}: 查询失败 (${(err as Error).message.slice(0, 40)})`);
      }
    }
  }
  const solRaw = process.env.SOLANA_PRIVATE_KEY;
  if (solRaw) {
    try {
      const secret = JSON.parse(solRaw) as number[];
      const pub = new PublicKey(Uint8Array.from(secret).slice(32));
      const conn = new Connection(
        process.env.SOLANA_RPC ?? "https://api.mainnet-beta.solana.com",
      );
      const lamports = await conn.getBalance(pub);
      lines.push(`SOL 地址: ${pub.toBase58()}\n  SOL: ${(lamports / 1e9).toFixed(5)}`);
    } catch (err) {
      lines.push(`SOL: 查询失败 (${(err as Error).message.slice(0, 40)})`);
    }
  }
  return lines.join("\n") || "未配置钱包私钥";
}

/**
 * Pull per-position strategy flags out of an arg list, returning the parsed
 * strategy (undefined if none present) and the remaining args (the free-text
 * reason). Shared by `buy` (initial plan) and `strategy` (later adjustment).
 *
 *   --hard-stop 0.35   --trail-stop 0.25   --trail-arm 1.5
 *   --max-hold 96      --tp 2:0.33,4:0.22  --note "一句计划"
 */
function extractStrategyFlags(args: string[]): {
  strategy: PositionStrategy | undefined;
  rest: string[];
} {
  const rest: string[] = [];
  const s: PositionStrategy = {};
  let seen = false;
  const valued: Record<string, (v: string) => void> = {
    "--hard-stop": (v) => (s.hardStopPct = Number(v)),
    "--trail-stop": (v) => (s.trailStopPct = Number(v)),
    "--trail-arm": (v) => (s.trailArmMultiple = Number(v)),
    "--max-hold": (v) => (s.maxHoldHours = Number(v)),
    "--note": (v) => (s.note = v),
    "--tp": (v) => {
      s.takeProfits = v
        .split(",")
        .map((t) => t.split(":"))
        .filter((pair) => pair.length === 2)
        .map(([m, f]) => ({ atMultiple: Number(m), sellFraction: Number(f) }));
    },
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const handler = valued[flag];
    if (handler) {
      handler(args[++i] ?? "");
      seen = true;
    } else {
      rest.push(flag);
    }
  }
  return { strategy: seen ? s : undefined, rest };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2).filter((a) => a !== "--");
  switch (cmd) {
    case "inbox": {
      const signals = await readAiInbox();
      console.log(JSON.stringify(signals, null, 2));
      break;
    }
    case "archive":
      await archiveAiInbox();
      console.log("inbox archived");
      break;
    case "buy": {
      const [chain, address, usd, ...rest] = args;
      if (!chain || !address || !usd) {
        console.error(
          "用法: ai-trade buy <chain> <address> <usd> [--smart-money] [--momentum] " +
            "[--hard-stop 0.35] [--trail-stop 0.25] [--trail-arm 1.5] [--tp 2:0.33,4:0.22] " +
            "[--max-hold 96] [--note \"计划\"] <reason...>",
        );
        process.exit(1);
      }
      const smIdx = rest.indexOf("--smart-money");
      const smartMoney = smIdx !== -1;
      if (smartMoney) rest.splice(smIdx, 1);
      const moIdx = rest.indexOf("--momentum");
      const momentum = moIdx !== -1;
      if (momentum) rest.splice(moIdx, 1);
      const { strategy, rest: reasonArgs } = extractStrategyFlags(rest);
      // 理由是决策留痕的核心（复盘只认决策时点证据），缺了就拒单，
      // 别默默记成"无"——2026-09-04 GME 补单就把论点全塞进了 --note。
      if (!reasonArgs.join(" ").trim()) {
        console.error(
          "缺少买入理由：<reason...> 是必填的位置参数（论点写这里，--note 写这仓的计划）",
        );
        process.exit(1);
      }
      console.log(
        await aiBuy(chain, address, Number(usd), reasonArgs.join(" "), {
          smartMoney,
          momentum,
          strategy,
        }),
      );
      break;
    }
    case "sell": {
      const [query, percent, ...reasonArgs] = args;
      if (!query) {
        console.error("用法: ai-trade sell <symbol|address> <percent> <理由...>（理由必填：本次卖出的动机）");
        process.exit(1);
      }
      const sellReason = reasonArgs.join(" ").trim();
      if (!sellReason) {
        console.error("缺少卖出理由：sell <symbol> <percent> <理由...>（和 buy 一样，留痕是硬要求）");
        process.exit(1);
      }
      console.log(await manualExit(query, (Number(percent) || 100) / 100, sellReason));
      break;
    }
    case "strategy": {
      const [query, ...flags] = args;
      if (!query) {
        console.error(
          "用法: ai-trade strategy <symbol|address> [--hard-stop 0.35] [--trail-stop 0.25] " +
            "[--trail-arm 1.5] [--tp 2:0.33,4:0.22] [--max-hold 96] [--note \"计划\"]",
        );
        process.exit(1);
      }
      const { strategy } = extractStrategyFlags(flags);
      if (!strategy) {
        console.error("未提供任何策略字段（--hard-stop/--trail-stop/--trail-arm/--tp/--max-hold/--note）");
        process.exit(1);
      }
      console.log(await setStrategy(query, strategy));
      break;
    }
    case "note": {
      const [chain, address, ...text] = args;
      if (!chain || !address || !text.length) {
        console.error("用法: ai-trade note <chain> <address> <text...>");
        process.exit(1);
      }
      const ok = await postToSignalThread(chain, address, `🤖 ${text.join(" ")}`);
      console.log(ok ? "posted to thread" : "该币无 thread(或缺 bot token)");
      break;
    }
    case "note-news": {
      // News signals carry no address/thread — trace their decisions to
      // #news-radar so negative-news exit calls aren't lost to log files.
      const text = args.join(" ");
      if (!text) {
        console.error("用法: ai-trade note-news <text...>");
        process.exit(1);
      }
      const url = resolveWebhook("news");
      if (!url) {
        console.log("未配置 DISCORD_NEWS_WEBHOOK_URL,跳过留痕");
        break;
      }
      await sendDiscordMessage(url, `🤖📰 ${text}`);
      console.log("posted to #news-radar");
      break;
    }
    case "research-note": {
      // 把研究结论写进某个待研究币的 #news-radar thread（needsResearch 信号）。
      // 该币没有 thread 时回落到平消息，避免结论丢进日志。
      const [symbol, ...text] = args;
      if (!symbol || !text.length) {
        console.error("用法: ai-trade research-note <symbol> <text...>");
        process.exit(1);
      }
      const line = text.join(" ");
      const ok = await postToNewsResearchThread(symbol, `🤖🔬 ${line}`);
      if (!ok) {
        const url = resolveWebhook("news");
        if (url) await sendDiscordMessage(url, `🤖🔬 ${symbol}: ${line}`);
      }
      console.log(ok ? "posted to research thread" : "该币无研究 thread(已回落平消息)");
      break;
    }
    case "status": {
      console.log(await formatPortfolioReport());
      console.log("\n=== 钱包余额 ===");
      console.log(await balances());
      // 自我出场复盘的近期教训 — 巡检第一步就是 status，塞这里让它自动看到。
      const { formatRecentLessons } = await import("../review/exits-review.js");
      const lessons = await formatRecentLessons().catch(() => "");
      if (lessons) console.log("\n" + lessons);
      break;
    }
    default:
      console.error(
        "用法: ai-trade inbox|archive|buy|sell|strategy|note|note-news|research-note|status",
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
