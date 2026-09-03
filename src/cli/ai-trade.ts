#!/usr/bin/env node
import { loadEnv } from "../lib/env.js";
loadEnv();

import { formatUnits } from "viem";
import { Connection, PublicKey } from "@solana/web3.js";

import { aiBuy, formatPortfolioReport, manualExit } from "../trade/engine.js";
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
 *   ai-trade buy <chain> <address> <usd> <reason...>
 *   ai-trade sell <symbol|address> <percent>
 *   ai-trade note <chain> <address> <text...>   决策摘要写进该币 thread
 *   ai-trade status              仓位 + 余额
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
      const [chain, address, usd, ...reason] = args;
      if (!chain || !address || !usd) {
        console.error("用法: ai-trade buy <chain> <address> <usd> <reason...>");
        process.exit(1);
      }
      console.log(await aiBuy(chain, address, Number(usd), reason.join(" ") || "无"));
      break;
    }
    case "sell": {
      const [query, percent] = args;
      if (!query) {
        console.error("用法: ai-trade sell <symbol|address> <percent>");
        process.exit(1);
      }
      console.log(await manualExit(query, (Number(percent) || 100) / 100));
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
    case "status":
      console.log(await formatPortfolioReport());
      console.log("\n=== 钱包余额 ===");
      console.log(await balances());
      break;
    default:
      console.error(
        "用法: ai-trade inbox|archive|buy|sell|note|note-news|research-note|status",
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
