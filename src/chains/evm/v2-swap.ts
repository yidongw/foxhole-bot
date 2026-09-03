import {
  createWalletClient,
  erc20Abi,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, bsc, mainnet } from "viem/chains";

import { fetchTokenPriceUsd } from "../../dex/dexscreener.js";
import type { ChainId } from "../adapter.js";
import { getEvmClient } from "./clients.js";

/**
 * UniswapV2-style router execution (PancakeSwap on BSC, Uniswap v2 on ETH).
 * ⚠️ UNTESTED WITH REAL FUNDS — paper-trade first; live requires
 * {BSC,ETH}_PRIVATE_KEY on a throwaway wallet.
 */

export const V2_ROUTERS: Partial<
  Record<ChainId, { router: Address; wrappedNative: Address; nativeSymbol: string; keyVar: string }>
> = {
  bsc: {
    router: "0x10ED43C718714eb63d5aA57B78B54704E256024E", // PancakeSwap v2
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB (verified on-chain: router.WETH())
    nativeSymbol: "BNB",
    keyVar: "BSC_PRIVATE_KEY",
  },
  base: {
    router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", // Uniswap v2 (Base)
    wrappedNative: "0x4200000000000000000000000000000000000006", // WETH
    nativeSymbol: "ETH",
    keyVar: "BASE_PRIVATE_KEY",
  },
  ethereum: {
    router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", // Uniswap v2
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
    nativeSymbol: "ETH",
    keyVar: "ETH_PRIVATE_KEY",
  },
};

const ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);

const VIEM_CHAINS = { bsc, base, ethereum: mainnet } as const;

function getWallet(chainId: ChainId) {
  const cfg = V2_ROUTERS[chainId];
  if (!cfg) throw new Error(`no v2 router config for ${chainId}`);
  const pk = process.env[cfg.keyVar];
  if (!pk) throw new Error(`${cfg.keyVar} not set — live trading unavailable on ${chainId}`);
  const account = privateKeyToAccount(pk as `0x${string}`);
  const chain = VIEM_CHAINS[chainId as keyof typeof VIEM_CHAINS];
  const transport = http(
    process.env[chainId === "bsc" ? "BSC_RPC" : chainId === "base" ? "BASE_RPC" : "ETH_RPC"] ??
      undefined,
  );
  return { account, wallet: createWalletClient({ account, chain, transport }) };
}

async function nativePriceUsd(chainId: ChainId): Promise<number> {
  const cfg = V2_ROUTERS[chainId]!;
  const price = await fetchTokenPriceUsd(cfg.wrappedNative, chainId);
  if (!price) throw new Error(`no ${cfg.nativeSymbol} price available`);
  return price;
}

export interface V2Fill {
  priceUsd: number;
  amountTokens: number;
  proceedsUsd?: number;
  txHash: `0x${string}`;
}

/** Real tokens received across a buy = post-swap balance minus pre-swap. */
export function tokensReceived(before: bigint, after: bigint): bigint {
  return after > before ? after - before : 0n;
}

/**
 * Real native proceeds from a sell = balance delta plus the gas this swap
 * burned (the raw delta is net of gas, so add it back). Never negative.
 */
export function nativeProceeds(
  before: bigint,
  after: bigint,
  gasCost: bigint,
): bigint {
  const received = after + gasCost - before;
  return received > 0n ? received : 0n;
}

/** Buy `usd` worth of `token` with native currency through the v2 router. */
export async function v2Buy(
  chainId: ChainId,
  token: Address,
  usd: number,
  slippageBps: number,
): Promise<V2Fill> {
  const cfg = V2_ROUTERS[chainId]!;
  const client: PublicClient = getEvmClient(chainId);
  const { account, wallet } = getWallet(chainId);

  const native = await nativePriceUsd(chainId);
  const amountIn = parseUnits((usd / native).toFixed(18), 18);
  const path = [cfg.wrappedNative, token];

  const amounts = await client.readContract({
    address: cfg.router,
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, path],
  });
  const quotedOut = amounts[amounts.length - 1];
  const minOut = (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  // Measure the real balance delta, not the pre-trade quote: we call the
  // fee-on-transfer swap variant precisely because many BSC memes tax
  // transfers, so tokens actually received are < quotedOut. Recording
  // quotedOut would overstate the position and corrupt P&L + sell sizing.
  const decimals = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "decimals",
  });
  const balBefore = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });

  const hash = await wallet.writeContract({
    address: cfg.router,
    abi: ROUTER_ABI,
    functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens",
    args: [minOut, path, account.address, deadline],
    value: amountIn,
    chain: wallet.chain,
    account,
  });
  await client.waitForTransactionReceipt({ hash });

  const balAfter = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  const received = tokensReceived(balBefore, balAfter);
  const amountTokens = Number(formatUnits(received, decimals));
  return {
    priceUsd: amountTokens > 0 ? usd / amountTokens : 0,
    amountTokens,
    txHash: hash,
  };
}

/** Sell `amountTokens` of `token` back to native through the v2 router. */
export async function v2Sell(
  chainId: ChainId,
  token: Address,
  amountTokens: number,
  slippageBps: number,
): Promise<V2Fill> {
  const cfg = V2_ROUTERS[chainId]!;
  const client: PublicClient = getEvmClient(chainId);
  const { account, wallet } = getWallet(chainId);

  const decimals = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "decimals",
  });
  const amountIn = parseUnits(amountTokens.toFixed(decimals), decimals);
  const path = [token, cfg.wrappedNative];

  const allowance = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, cfg.router],
  });
  if (allowance < amountIn) {
    const approveHash = await wallet.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [cfg.router, amountIn],
      chain: wallet.chain,
      account,
    });
    await client.waitForTransactionReceipt({ hash: approveHash });
  }

  const amounts = await client.readContract({
    address: cfg.router,
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, path],
  });
  const quotedOut = amounts[amounts.length - 1];
  const minOut = (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  // Real proceeds = native balance delta + gas spent on this swap (the delta
  // is net of gas). Measured here, after any approve tx, so approval gas is
  // excluded. Beats the pre-trade quote for the same fee-on-transfer reason
  // as the buy side.
  const nativeBefore = await client.getBalance({ address: account.address });
  const hash = await wallet.writeContract({
    address: cfg.router,
    abi: ROUTER_ABI,
    functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
    args: [amountIn, minOut, path, account.address, deadline],
    chain: wallet.chain,
    account,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  const nativeAfter = await client.getBalance({ address: account.address });
  const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
  const proceedsNative = nativeProceeds(nativeBefore, nativeAfter, gasCost);

  const native = await nativePriceUsd(chainId);
  const proceedsUsd = Number(formatUnits(proceedsNative, 18)) * native;
  return {
    priceUsd: amountTokens > 0 ? proceedsUsd / amountTokens : 0,
    amountTokens,
    proceedsUsd,
    txHash: hash,
  };
}
