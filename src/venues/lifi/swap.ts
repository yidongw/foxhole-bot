/**
 * 用 LI.FI 聚合器在 Robinhood Chain 上执行一次同链 swap:取 quote(带可广播 tx)
 * → 按需授权 → **广播前 eth_call 模拟** → 签名广播 → 校验回执。
 *
 * 失败分两类(同 OKX 的纪律):
 *  - 广播前(quote/授权/模拟)失败 → LifiRouteError(RouteError 子类),
 *    上层可安全回退 hoodchain(未成交,不会重复买)。
 *  - 广播后失败 → 抛普通 Error,不回退。
 *
 * ⚠️ 首单前用小额在 RB 主网跑通(已 smoke:USDG→WETH 模拟通过)。
 */
import { erc20Abi, maxUint256, type Address } from "viem";

import { getTradingClient, waitForReceiptResilient } from "../../chain/client.js";
import { RouteError } from "../route-error.js";
import { getLifiQuote } from "./dex.js";

export class LifiRouteError extends RouteError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LifiRouteError";
  }
}

export interface LifiSwapOutcome {
  amountOutBase: bigint;
  toDecimals: number;
  txHash: `0x${string}`;
}

export async function lifiSwap(
  fromToken: Address,
  toToken: Address,
  amountIn: bigint,
  slippageBps: number,
): Promise<LifiSwapOutcome> {
  const client = getTradingClient();
  const account = client.account;
  if (!account || !client.wallet) {
    throw new Error("LI.FI 路由需要带钱包的交易客户端(TRADER_PRIVATE_KEY 未设置)");
  }
  const walletClient = client.wallet;
  const wallet = account.address as Address;

  // ── 广播前:任何失败抛 LifiRouteError(可回退)──
  let quote: Awaited<ReturnType<typeof getLifiQuote>>;
  try {
    quote = await getLifiQuote({
      fromToken,
      toToken,
      fromAmount: amountIn.toString(),
      fromAddress: wallet,
      slippage: (slippageBps / 10_000).toString(),
    });

    // 授权 fromToken 给 LI.FI diamond(allowance 不足才发 approve)。
    const spender = quote.approvalAddress as Address;
    const allowance = (await client.public.readContract({
      address: fromToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [wallet, spender],
    })) as bigint;
    if (allowance < amountIn) {
      const approveHash = await walletClient.writeContract({
        account,
        chain: client.chain,
        address: fromToken,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, maxUint256],
      });
      await waitForReceiptResilient(client.public, approveHash);
    }

    // 广播前模拟 LI.FI 返回的 calldata(和 OKX 一样,杜绝广播注定 revert 的交易)。
    await client.public.call({
      account: wallet,
      to: quote.tx.to as `0x${string}`,
      data: quote.tx.data as `0x${string}`,
      value: quote.tx.value ? BigInt(quote.tx.value) : 0n,
      ...(quote.tx.gasLimit ? { gas: BigInt(quote.tx.gasLimit) } : {}),
    });
  } catch (err) {
    throw new LifiRouteError(
      `LI.FI 路由/构建/模拟失败: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // ── 广播阶段:此后失败抛普通 Error,不回退 ──
  const swapHash = await walletClient.sendTransaction({
    account,
    chain: client.chain,
    to: quote.tx.to as `0x${string}`,
    data: quote.tx.data as `0x${string}`,
    value: quote.tx.value ? BigInt(quote.tx.value) : 0n,
    ...(quote.tx.gasLimit ? { gas: BigInt(quote.tx.gasLimit) } : {}),
  });
  const receipt = await waitForReceiptResilient(client.public, swapHash);
  if (receipt.status !== "success") {
    throw new Error(`LI.FI swap 交易 revert(${swapHash})`);
  }

  return {
    amountOutBase: BigInt(quote.toAmount),
    toDecimals: quote.toDecimals,
    txHash: swapHash,
  };
}
