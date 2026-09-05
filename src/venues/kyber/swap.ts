/**
 * 用 KyberSwap 聚合器在 Robinhood Chain 上执行一次同链 swap:取路由 → 按需授权
 * → **广播前 eth_call 模拟** → 签名广播 → 校验回执。
 *
 * 失败分两类(同 LI.FI / OKX 的纪律):
 *  - 广播前(路由/授权/构建/模拟)失败 → KyberRouteError(RouteError 子类),
 *    上层可安全回退下一条腿(未成交,不会重复买)。
 *  - 广播后失败 → 抛普通 Error,不回退。
 */
import { erc20Abi, maxUint256, type Address } from "viem";

import { getTradingClient, waitForReceiptResilient } from "../../chain/client.js";
import { RouteError } from "../route-error.js";
import { KYBER_NATIVE } from "./config.js";
import { buildKyberTx, getKyberRoute } from "./dex.js";

export class KyberRouteError extends RouteError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "KyberRouteError";
  }
}

export interface KyberSwapOutcome {
  amountOutBase: bigint;
  toDecimals: number;
  txHash: `0x${string}`;
}

const isNative = (a: string): boolean =>
  a.toLowerCase() === KYBER_NATIVE.toLowerCase() ||
  a === "0x0000000000000000000000000000000000000000";

export async function kyberSwap(
  fromToken: Address,
  toToken: Address,
  amountIn: bigint,
  slippageBps: number,
): Promise<KyberSwapOutcome> {
  const client = getTradingClient();
  const account = client.account;
  if (!account || !client.wallet) {
    throw new Error("Kyber 路由需要带钱包的交易客户端(TRADER_PRIVATE_KEY 未设置)");
  }
  const walletClient = client.wallet;
  const wallet = account.address as Address;

  // ── 广播前:任何失败抛 KyberRouteError(可回退)──
  let tx: Awaited<ReturnType<typeof buildKyberTx>>;
  let amountOut: string;
  try {
    const route = await getKyberRoute({
      tokenIn: fromToken,
      tokenOut: toToken,
      amountIn: amountIn.toString(),
    });
    amountOut = route.routeSummary.amountOut;

    // 授权 fromToken 给 Kyber router(原生入场无需授权;allowance 不足才发 approve)。
    const spender = route.routerAddress as Address;
    if (!isNative(fromToken)) {
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
    }

    tx = await buildKyberTx({
      routeSummary: route.routeSummary,
      sender: wallet,
      recipient: wallet,
      slippageBps,
    });

    // 广播前模拟 Kyber 返回的 calldata(杜绝广播注定 revert 的交易)。
    await client.public.call({
      account: wallet,
      to: tx.routerAddress as `0x${string}`,
      data: tx.data as `0x${string}`,
      value: tx.transactionValue ? BigInt(tx.transactionValue) : 0n,
    });
  } catch (err) {
    throw new KyberRouteError(
      `Kyber 路由/构建/模拟失败: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // ── 广播阶段:此后失败抛普通 Error,不回退 ──
  const swapHash = await walletClient.sendTransaction({
    account,
    chain: client.chain,
    to: tx.routerAddress as `0x${string}`,
    data: tx.data as `0x${string}`,
    value: tx.transactionValue ? BigInt(tx.transactionValue) : 0n,
  });
  const receipt = await waitForReceiptResilient(client.public, swapHash);
  if (receipt.status !== "success") {
    throw new Error(`Kyber swap 交易 revert(${swapHash})`);
  }

  // toToken 一律是 ERC20(买=meme 18dp,卖=USDG 6dp),读链上 decimals 换算。
  const toDecimals = Number(
    await client.public.readContract({
      address: toToken,
      abi: erc20Abi,
      functionName: "decimals",
    }),
  );
  return { amountOutBase: BigInt(amountOut), toDecimals, txHash: swapHash };
}
