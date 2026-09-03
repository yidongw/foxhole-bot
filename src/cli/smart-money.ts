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

  console.error(`未知命令: ${cmd}。可用: list | add | rm | find`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
