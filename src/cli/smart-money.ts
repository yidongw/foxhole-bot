#!/usr/bin/env node
import { loadEnv } from "../lib/env.js";
loadEnv();

import {
  addTrackedWallet,
  loadTrackedWallets,
  removeTrackedWallet,
  walletChain,
} from "../chains/robinhood/smart-money.js";
import { findWinners } from "../smartmoney/profit.js";
import {
  loadConfig,
  resolveFilterSync,
  saveConfig,
  type SmartMoneyFilter,
} from "../smartmoney/config.js";

const KNOWN_CHAINS = new Set([
  "robinhood",
  "bsc",
  "sol",
  "solana",
  "base",
  "eth",
  "ethereum",
]);

/**
 * 聪明钱地址簿 + 选钱包 CLI.
 *   smartmoney list
 *   smartmoney add <address> <label...> [--chain <chain>]
 *   smartmoney rm  <address>
 *   smartmoney find <chain> <token[,token2,...]> [--add-top N] [--min-usd N]
 */

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === "list") {
    const wallets = await loadTrackedWallets();
    if (!wallets.length) {
      console.log("追踪列表为空。用 `npm run smartmoney add <地址> <标签>` 添加。");
      return;
    }
    for (const w of wallets) {
      console.log(`[${walletChain(w)}] ${w.address}  ${w.label}`);
    }
    console.log(`\n共 ${wallets.length} 个地址。`);
    return;
  }

  if (cmd === "add") {
    const positional = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--chain");
    const [address, ...labelParts] = positional;
    const chain = (flag("chain") ?? "robinhood").toLowerCase();
    if (!address) {
      console.error("用法: smartmoney add <address> <label...> [--chain <chain>]");
      process.exit(1);
    }
    try {
      const { added, wallets } = await addTrackedWallet(
        address,
        labelParts.join(" ") || "wallet",
        "cli",
        chain,
      );
      console.log(
        added
          ? `✅ 已添加 [${chain}] ${address}，现共 ${wallets.length} 个。`
          : `已存在，跳过 ${address}。`,
      );
    } catch (err) {
      console.error(`地址无效: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "rm" || cmd === "remove") {
    const [address] = rest;
    if (!address) {
      console.error("用法: smartmoney rm <address>");
      process.exit(1);
    }
    const { removed, wallets } = await removeTrackedWallet(address);
    console.log(
      removed
        ? `🗑️ 已移除 ${address}，现共 ${wallets.length} 个。`
        : `未找到 ${address}。`,
    );
    return;
  }

  if (cmd === "find") {
    const [chain, tokenArg] = rest;
    if (!chain || !tokenArg) {
      console.error(
        "用法: smartmoney find <chain> <token[,token2,...]> [--add-top N] [--min-usd N]",
      );
      process.exit(1);
    }
    const tokens = tokenArg.split(",").map((address) => ({ address }));
    const minUsd = Number(flag("min-usd") ?? 1000);
    console.log(`查询 ${chain} 上 ${tokens.length} 个币的盈利钱包…`);
    const { candidates, perToken } = await findWinners(chain, tokens, {
      minRealizedUsd: minUsd,
      delayMs: 14_000, // pace to avoid GMGN rate limits on the shared key
    });
    for (const [name, status] of Object.entries(perToken)) console.log(`  [${name}] ${status}`);

    const cross = candidates.filter((c) => c.tokens.length >= 2);
    console.log(`\n=== 跨币赢家(≥2 个币)${cross.length} 个 ===`);
    for (const c of cross) {
      console.log(
        `${c.address}  x${c.tokens.length} ${JSON.stringify(c.tokens)}  realized=$${Math.round(c.realizedUsd).toLocaleString()}  ${c.tags.slice(0, 3).join(",")}`,
      );
    }

    const addTop = Number(flag("add-top") ?? 0);
    if (addTop > 0) {
      const pick = (cross.length ? cross : candidates).slice(0, addTop);
      let added = 0;
      for (const c of pick) {
        const label = `gmgn x${c.tokens.length} $${Math.round(c.realizedUsd / 1000)}k`;
        const r = await addTrackedWallet(c.address, label, "winner-finder", chain);
        if (r.added) added++;
      }
      console.log(`\n✅ 已加入追踪 ${added} 个(chain=${chain})。`);
    } else {
      console.log(`\n(加 --add-top N 可自动把前 N 个加入追踪)`);
    }
    return;
  }

  if (cmd === "config") {
    const config = await loadConfig();
    const wallets = await loadTrackedWallets();
    const chains = [...new Set(wallets.map((w) => walletChain(w)))];
    console.log("=== 每条链的过滤 / AI 唤醒条件 ===");
    for (const c of chains.length ? chains : ["robinhood", "bsc", "sol"]) {
      const f = resolveFilterSync(config, c, "0x0");
      console.log(
        `[${c}] 警报≥$${f.alertMinUsd} · AI唤醒: ${f.aiConvictionN}钱包/${f.aiWindowMin}min 且每笔≥$${f.aiMinUsd}${f.soloTrigger ? " · solo" : ""}`,
      );
    }
    const overrides = Object.keys(config.wallets);
    if (overrides.length) {
      console.log("\n=== 单地址覆盖 ===");
      for (const a of overrides) console.log(`  ${a}: ${JSON.stringify(config.wallets[a])}`);
    }
    return;
  }

  if (cmd === "filter") {
    const [target] = rest;
    if (!target) {
      console.error(
        "用法: smartmoney filter <chain|地址> [--min-usd N] [--conviction N] [--window N] [--ai-min-usd N] [--solo true|false]",
      );
      process.exit(1);
    }
    const patch: Partial<SmartMoneyFilter> = {};
    if (flag("min-usd") != null) patch.alertMinUsd = Number(flag("min-usd"));
    if (flag("conviction") != null) patch.aiConvictionN = Number(flag("conviction"));
    if (flag("window") != null) patch.aiWindowMin = Number(flag("window"));
    if (flag("ai-min-usd") != null) patch.aiMinUsd = Number(flag("ai-min-usd"));
    if (flag("solo") != null) patch.soloTrigger = flag("solo") === "true";
    if (!Object.keys(patch).length) {
      console.error("没有要改的字段。加 --min-usd / --conviction / --window / --ai-min-usd / --solo");
      process.exit(1);
    }
    const config = await loadConfig();
    const isChain = KNOWN_CHAINS.has(target.toLowerCase());
    const bucket = isChain ? config.chains : config.wallets;
    const kk = isChain ? target.toLowerCase() : target.toLowerCase();
    bucket[kk] = { ...(bucket[kk] ?? {}), ...patch };
    await saveConfig(config);
    console.log(
      `✅ 已更新 ${isChain ? "链" : "地址"} ${target} 的过滤: ${JSON.stringify(bucket[kk])}`,
    );
    return;
  }

  console.error(`未知命令: ${cmd}。可用: list | add | rm | find | config | filter`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
