/**
 * 用 OKX 聚合器在 Robinhood Chain 上执行一次 swap:授权(按需)→ 取 swap tx →
 * 用 hoodchain 的钱包客户端签名广播 → 等回执。返回预期/实际成交量。
 *
 * ⚠️ 未经真金验证 —— 需要 OKX 凭证且要在 RB 主网跑通首单;与仓库其它 live
 *    路径同纪律,先小额验证再放量。
 */
import { erc20Abi, type Address } from "viem";

import { getTradingClient } from "../../chain/client.js";
import { OKX_RB_CHAIN_INDEX } from "./config.js";
import { getApproveTransaction, getSwap } from "./dex.js";

export interface OkxSwapOutcome {
  /** 实际/预期成交的 toToken 数量,最小单位。 */
  amountOutBase: bigint;
  /** toToken 精度。 */
  toDecimals: number;
  txHash: `0x${string}`;
}

/**
 * @param fromToken 卖出 token 合约
 * @param toToken   买入 token 合约
 * @param amountIn  卖出量(最小单位)
 * @param slippageBps 滑点,基点(100 = 1%)
 */
export async function okxSwap(
  fromToken: Address,
  toToken: Address,
  amountIn: bigint,
  slippageBps: number,
): Promise<OkxSwapOutcome> {
  const client = getTradingClient();
  const account = client.account;
  if (!account || !client.wallet) {
    throw new Error("OKX 路由需要带钱包的交易客户端(TRADER_PRIVATE_KEY 未设置)");
  }
  const walletClient = client.wallet;
  const wallet = account.address as Address;
  const amountStr = amountIn.toString();

  // 1) 确保 fromToken 已授权给 OKX 的 spender。allowance 不足才发 approve。
  const approve = await getApproveTransaction({
    chainIndex: OKX_RB_CHAIN_INDEX,
    tokenContractAddress: fromToken,
    approveAmount: amountStr,
  });
  const spender = approve.dexContractAddress as Address;
  const allowance = (await client.public.readContract({
    address: fromToken,
    abi: erc20Abi,
    functionName: "allowance",
    args: [wallet, spender],
  })) as bigint;
  if (allowance < amountIn) {
    const approveHash = await walletClient.sendTransaction({
      account,
      chain: client.chain,
      to: fromToken,
      data: approve.data as `0x${string}`,
    });
    await client.public.waitForTransactionReceipt({ hash: approveHash });
  }

  // 2) 取 swap 交易并广播。slippage 用十进制小数。
  const swap = await getSwap({
    chainIndex: OKX_RB_CHAIN_INDEX,
    fromTokenAddress: fromToken,
    toTokenAddress: toToken,
    amount: amountStr,
    slippage: (slippageBps / 10_000).toString(),
    userWalletAddress: wallet,
  });

  const { tx, routerResult } = swap;
  const swapHash = await walletClient.sendTransaction({
    account,
    chain: client.chain,
    to: tx.to as `0x${string}`,
    data: tx.data as `0x${string}`,
    value: tx.value ? BigInt(tx.value) : 0n,
    ...(tx.gas ? { gas: BigInt(tx.gas) } : {}),
  });
  await client.public.waitForTransactionReceipt({ hash: swapHash });

  return {
    amountOutBase: BigInt(routerResult.toTokenAmount),
    toDecimals: Number(routerResult.toToken.decimal),
    txHash: swapHash,
  };
}
