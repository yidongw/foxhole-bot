import { type Address, type Hex, erc20Abi, parseAbi } from "viem";
import { createRobinhoodPublicClient } from "./client.js";
import { amountsForLiquidity } from "./pool-math.js";

const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b" as Address;

const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 id) view returns (uint128 liquidity)",
]);

export interface PoolLockAnchor {
  createdAtBlock: number;
  createdAtMs: number;
  /** Average block time seconds on Robinhood Chain (~2s). */
  blockTimeSec?: number;
}

export function estimateBlockForTime(
  anchor: PoolLockAnchor,
  targetMs: number,
): bigint {
  const blockTime = anchor.blockTimeSec ?? 2;
  const deltaSec = (targetMs - anchor.createdAtMs) / 1000;
  const blocks = Math.max(0, Math.floor(deltaSec / blockTime));
  return BigInt(anchor.createdAtBlock + blocks);
}

export interface QuoteLockSample {
  blockNumber: bigint;
  quoteLocked: bigint;
  quoteTotalSupply: bigint;
  quoteLockRatio: number;
  source: "archive-rpc";
}

const lockCache = new Map<string, QuoteLockSample | null>();

/**
 * Read historical quote lock ratio at a block via archive RPC (Alchemy recommended).
 * token0 = base meme, token1 = quote stock token (DexPaprika ordering for Long.xyz pools).
 */
export async function sampleQuoteLockAtBlock(
  poolId: Hex,
  quoteToken: Address,
  token0IsQuote: boolean,
  blockNumber: bigint,
): Promise<QuoteLockSample | null> {
  const key = `${poolId}:${blockNumber}:${quoteToken}`;
  if (lockCache.has(key)) return lockCache.get(key) ?? null;

  const client = createRobinhoodPublicClient();
  try {
    const [slot0, liquidity, totalSupply] = await Promise.all([
      client.readContract({
        address: STATE_VIEW,
        abi: stateViewAbi,
        functionName: "getSlot0",
        args: [poolId],
        blockNumber,
      }),
      client.readContract({
        address: STATE_VIEW,
        abi: stateViewAbi,
        functionName: "getLiquidity",
        args: [poolId],
        blockNumber,
      }),
      client.readContract({
        address: quoteToken,
        abi: erc20Abi,
        functionName: "totalSupply",
        blockNumber,
      }),
    ]);

    const { amount0, amount1 } = amountsForLiquidity(
      BigInt(liquidity),
      BigInt(slot0[0]),
    );
    const quoteLocked = token0IsQuote ? amount0 : amount1;
    if (totalSupply === 0n) return null;

    const sample: QuoteLockSample = {
      blockNumber,
      quoteLocked,
      quoteTotalSupply: totalSupply,
      quoteLockRatio: Number(quoteLocked) / Number(totalSupply),
      source: "archive-rpc",
    };
    lockCache.set(key, sample);
    return sample;
  } catch {
    lockCache.set(key, null);
    return null;
  }
}

export function supportsArchiveRpc(): boolean {
  const url = process.env.ROBINHOOD_RPC ?? "";
  return /alchemy\.com|quiknode|infura/i.test(url);
}
