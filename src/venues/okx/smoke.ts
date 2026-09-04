/**
 * OKX DEX 接入冒烟测试 —— `npm run okx`。
 *
 * 一次性验证三件事:
 *   1. 凭证齐全且签名被 OKX 接受(能过鉴权);
 *   2. DoH+IP 直连绕过了被屏蔽的本地 DNS(能连上 web3.okx.com);
 *   3. Robinhood Chain(chainIndex 4663)确实在聚合器支持列表里,且能出报价。
 *
 * 拿到 OKX 凭证后跑这个即可确认能否翻 live。无凭证时给出明确提示,不报栈。
 */
import { MAINNET_ADDRESSES, parseUsdg } from "hoodchain";

import { loadEnv } from "../../lib/env.js";
import { okxConfigured, OKX_RB_CHAIN_INDEX } from "./config.js";
import { getQuote, getSupportedChains } from "./dex.js";

async function main() {
  loadEnv();

  if (!okxConfigured()) {
    console.error(
      "✗ OKX 凭证未配置。请在 .env 设置 OKX_API_KEY / OKX_API_SECRET / " +
        "OKX_API_PASSPHRASE / OKX_PROJECT_ID 后重试(OKX Web3 开发者后台申请)。",
    );
    process.exit(1);
  }

  console.log("→ 查询 OKX 聚合器支持的链…");
  const chains = await getSupportedChains();
  const rb = chains.find((c) => String(c.chainIndex) === OKX_RB_CHAIN_INDEX);
  if (!rb) {
    console.error(
      `✗ OKX 聚合器未列出 Robinhood Chain(chainIndex ${OKX_RB_CHAIN_INDEX})。` +
        `当前共 ${chains.length} 条链。`,
    );
    process.exit(2);
  }
  console.log(
    `✓ 找到 RB 链:${rb.chainName}(chainIndex ${rb.chainIndex}), ` +
      `spender=${rb.dexTokenApproveAddress}`,
  );

  console.log("→ 试报价 1 USDG → WETH …");
  const q = await getQuote({
    chainIndex: OKX_RB_CHAIN_INDEX,
    fromTokenAddress: MAINNET_ADDRESSES.usdg,
    toTokenAddress: MAINNET_ADDRESSES.weth,
    amount: parseUsdg("1").toString(),
  });
  console.log(
    `✓ 报价 OK:${q.fromTokenAmount} ${q.fromToken.tokenSymbol} → ` +
      `${q.toTokenAmount} ${q.toToken.tokenSymbol}(gas≈${q.estimateGasFee})`,
  );
  console.log("\n✅ OKX DEX 接入可用:鉴权/DNS/RB 链报价全部通过。");
}

main().catch((err) => {
  console.error("✗ 冒烟测试失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
