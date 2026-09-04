/**
 * 用 OKX 聚合器在 Robinhood Chain 上执行一次 swap:授权(按需)→ 取 swap tx →
 * 用 hoodchain 的钱包客户端签名广播 → 等回执。返回预期/实际成交量。
 *
 * ⚠️ 未经真金验证 —— 需要 OKX 凭证且要在 RB 主网跑通首单;与仓库其它 live
 *    路径同纪律,先小额验证再放量。
 *
 * 失败分两类,给上层的 fallback 用:
 *  - **路由/构建阶段**失败(OKX API 挂、无路由、授权失败)——尚未广播 swap,
 *    抛 `OkxRouteError`,上层可安全回退 hoodchain(没有成交,不会重复买)。
 *  - **广播阶段**失败(swap tx 已发出后)——抛原始错误,上层**不得**回退,
 *    否则可能重复下单。
 */
import { erc20Abi, type Address } from "viem";

import { getTradingClient, waitForReceiptResilient } from "../../chain/client.js";
import { RouteError } from "../route-error.js";
import { OKX_RB_CHAIN_INDEX } from "./config.js";
import { getApproveTransaction, getSwap } from "./dex.js";

/** 路由/构建阶段(swap 广播前)的失败——可安全回退到其它路由。 */
export class OkxRouteError extends RouteError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OkxRouteError";
  }
}

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

  // ── 路由/构建阶段:任何失败都抛 OkxRouteError(还没广播 swap,可回退)──
  let tx: Awaited<ReturnType<typeof getSwap>>["tx"];
  let routerResult: Awaited<ReturnType<typeof getSwap>>["routerResult"];
  try {
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
      await waitForReceiptResilient(client.public, approveHash);
    }

    // 2) 取 swap 交易(仅构建,未广播)。V6 用 slippagePercent(百分数)。
    const swap = await getSwap({
      chainIndex: OKX_RB_CHAIN_INDEX,
      fromTokenAddress: fromToken,
      toTokenAddress: toToken,
      amount: amountStr,
      slippagePercent: (slippageBps / 100).toString(),
      userWalletAddress: wallet,
    });
    tx = swap.tx;
    routerResult = swap.routerResult;

    // 广播前先 eth_call 模拟 OKX 返回的 calldata。OKX 在 RB 链会返回能报价、
    // 但执行会 revert("adaptor call failed")的路由(实测 2026-09-04,quote 通、
    // swap 恒 revert)。模拟失败即视为路由不可用 → 抛 OkxRouteError 让上层回退,
    // 绝不浪费 gas 广播一笔注定 revert 的交易。
    await client.public.call({
      account: wallet,
      to: tx.to as `0x${string}`,
      data: tx.data as `0x${string}`,
      value: tx.value ? BigInt(tx.value) : 0n,
      ...(tx.gas ? { gas: BigInt(tx.gas) } : {}),
    });
  } catch (err) {
    throw new OkxRouteError(
      `OKX 路由/构建/模拟失败: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // ── 广播阶段:此后失败抛原始错误,上层不得回退(可能已成交)──
  const swapHash = await walletClient.sendTransaction({
    account,
    chain: client.chain,
    to: tx.to as `0x${string}`,
    data: tx.data as `0x${string}`,
    value: tx.value ? BigInt(tx.value) : 0n,
    ...(tx.gas ? { gas: BigInt(tx.gas) } : {}),
  });
  const receipt = await waitForReceiptResilient(client.public, swapHash);
  // 回执必须成功:reverted 不抛错,不查就会把 revert 的 swap 当成交(2026-09-04
  // 实测踩过)。用 resilient 轮询容忍 RB RPC 的 block-not-found 抖动,避免把
  // 已上链的成交误判为失败而重试导致重复买入(SHROOM 事故)。
  if (receipt.status !== "success") {
    throw new Error(`OKX swap 交易 revert(${swapHash})`);
  }

  return {
    amountOutBase: BigInt(routerResult.toTokenAmount),
    toDecimals: Number(routerResult.toToken.decimal),
    txHash: swapHash,
  };
}
