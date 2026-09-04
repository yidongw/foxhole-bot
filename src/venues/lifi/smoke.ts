/**
 * LI.FI 接入冒烟测试 —— `npm run lifi`。只报价 + 广播前模拟,不下真单。
 * 验证:LI.FI 支持 RB(4663)、能出报价、且返回的 tx 能通过 eth_call 模拟
 * (即真能执行,区别于 OKX 的 quote-only)。需 TRADER_PRIVATE_KEY(用地址)。
 */
import { MAINNET_ADDRESSES, parseUsdg } from "hoodchain";
import { type Address } from "viem";

import { loadEnv } from "../../lib/env.js";
import { getTradingClient } from "../../chain/client.js";
import { getLifiQuote } from "./dex.js";

async function main() {
  loadEnv();
  const client = getTradingClient();
  const wallet = client.account?.address;
  if (!wallet) {
    console.error("✗ 需要 TRADER_PRIVATE_KEY(取钱包地址用于报价)。");
    process.exit(1);
  }

  console.log("→ LI.FI 报价 1 USDG → WETH (RB 4663) …");
  const q = await getLifiQuote({
    fromToken: MAINNET_ADDRESSES.usdg,
    toToken: MAINNET_ADDRESSES.weth,
    fromAmount: parseUsdg("1").toString(),
    fromAddress: wallet,
    slippage: "0.01",
  });
  console.log(`✓ 路由 ${q.toolName}:1 USDG → ${q.toAmount} WETH(approval=${q.approvalAddress})`);

  console.log("→ 广播前 eth_call 模拟返回的 tx …");
  await client.public.call({
    account: wallet as Address,
    to: q.tx.to as `0x${string}`,
    data: q.tx.data as `0x${string}`,
    value: q.tx.value ? BigInt(q.tx.value) : 0n,
    ...(q.tx.gasLimit ? { gas: BigInt(q.tx.gasLimit) } : {}),
  });
  console.log("\n✅ LI.FI 接入可用:RB 报价 + 执行模拟均通过。");
}

main().catch((err) => {
  console.error("✗ 冒烟测试失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
