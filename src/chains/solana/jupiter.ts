import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { createJupiterApiClient } from "@jup-ag/api";

import { fetchTokenPriceUsd } from "../../dex/dexscreener.js";
import { getMintDecimals, getSolanaConnection } from "./pumpfun.js";

/**
 * Jupiter swap execution via the free lite API (no key).
 * ⚠️ UNTESTED WITH REAL FUNDS — paper-trade first; live requires
 * SOLANA_PRIVATE_KEY (base58 or JSON byte array) on a throwaway wallet.
 */

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS = 1_000_000_000;

/**
 * Max acceptable price impact (fraction) for a Jupiter swap. Thin pump.fun
 * pools can quote catastrophic impact (a $50 buy moving price 40%+); rejecting
 * above this keeps the entry/exit from eating the position. Override via
 * JUPITER_MAX_PRICE_IMPACT_PCT (e.g. 0.15 = 15%).
 */
export function maxPriceImpact(): number {
  return Number(process.env.JUPITER_MAX_PRICE_IMPACT_PCT ?? 0.15);
}

/** Pure guard: returns a veto reason when impact exceeds the cap, else undefined. */
export function priceImpactVeto(
  priceImpactPct: string | number | undefined,
  maxPct: number,
): string | undefined {
  const impact = Number(priceImpactPct ?? 0);
  if (!Number.isFinite(impact)) return undefined;
  if (impact > maxPct) {
    return `price impact ${(impact * 100).toFixed(1)}% > ${(maxPct * 100).toFixed(0)}% cap`;
  }
  return undefined;
}

const PRIORITY_LEVELS = ["medium", "high", "veryHigh"] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

/**
 * Priority-fee config for the swap. Without a priority fee, meme swaps
 * routinely fail to land during congestion. Dynamic estimation (priorityLevel)
 * is capped by maxLamports so we never overpay. Env:
 *   JUPITER_PRIORITY_LEVEL       medium|high|veryHigh (default high)
 *   JUPITER_PRIORITY_FEE_MAX_LAMPORTS  cap (default 1_000_000 = 0.001 SOL)
 */
export function priorityFeeConfig(): { level: PriorityLevel; maxLamports: number } {
  const raw = (process.env.JUPITER_PRIORITY_LEVEL ?? "high") as PriorityLevel;
  const level = PRIORITY_LEVELS.includes(raw) ? raw : "high";
  const maxLamports = Math.max(
    0,
    Math.floor(Number(process.env.JUPITER_PRIORITY_FEE_MAX_LAMPORTS ?? 1_000_000)),
  );
  return { level, maxLamports };
}

const jupiter = createJupiterApiClient({
  basePath: process.env.JUPITER_API_BASE ?? "https://lite-api.jup.ag/swap/v1",
});

const B58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function decodeBase58(input: string): Uint8Array {
  let n = 0n;
  for (const ch of input) {
    const idx = B58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base58 character");
    n = n * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of input) {
    if (ch === "1") bytes.unshift(0);
    else break;
  }
  return Uint8Array.from(bytes);
}

function getKeypair(): Keypair {
  const raw = process.env.SOLANA_PRIVATE_KEY;
  if (!raw) throw new Error("SOLANA_PRIVATE_KEY not set — live trading unavailable on solana");
  const secret = raw.trim().startsWith("[")
    ? Uint8Array.from(JSON.parse(raw) as number[])
    : decodeBase58(raw.trim());
  return Keypair.fromSecretKey(secret);
}

async function solPriceUsd(): Promise<number> {
  const price = await fetchTokenPriceUsd(WSOL_MINT, "solana");
  if (!price) throw new Error("no SOL price available");
  return price;
}

export interface JupiterFill {
  priceUsd: number;
  amountTokens: number;
  proceedsUsd?: number;
  txHash: string;
}

async function executeJupiterSwap(
  inputMint: string,
  outputMint: string,
  amountRaw: number,
  slippageBps: number,
): Promise<{ outAmountRaw: bigint; txHash: string }> {
  const keypair = getKeypair();
  const quote = await jupiter.quoteGet({
    inputMint,
    outputMint,
    amount: Math.floor(amountRaw),
    slippageBps,
  });

  const veto = priceImpactVeto(quote.priceImpactPct, maxPriceImpact());
  if (veto) throw new Error(`jupiter swap rejected: ${veto}`);

  const { level, maxLamports } = priorityFeeConfig();
  const swap = await jupiter.swapPost({
    swapRequest: {
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      dynamicComputeUnitLimit: true,
      // Dynamic priority fee (capped) so the swap actually lands under load.
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { priorityLevel: level, maxLamports, global: false },
      },
    },
  });

  const tx = VersionedTransaction.deserialize(
    Buffer.from(swap.swapTransaction, "base64"),
  );
  tx.sign([keypair]);

  const connection = getSolanaConnection();
  const txHash = await connection.sendRawTransaction(tx.serialize(), {
    maxRetries: 3,
  });
  // Confirm against the transaction's OWN blockhash + Jupiter's
  // lastValidBlockHeight — a freshly-fetched blockhash would not match the
  // signed tx and can confirm/expire incorrectly.
  const result = await connection.confirmTransaction(
    {
      signature: txHash,
      blockhash: tx.message.recentBlockhash,
      lastValidBlockHeight: swap.lastValidBlockHeight,
    },
    "confirmed",
  );
  if (result.value.err) {
    throw new Error(
      `jupiter swap failed on-chain (${txHash}): ${JSON.stringify(result.value.err)}`,
    );
  }
  return { outAmountRaw: BigInt(quote.outAmount), txHash };
}

/** Buy `usd` worth of `mint` with SOL. Resolves real SPL decimals unless overridden. */
export async function jupiterBuy(
  mint: string,
  usd: number,
  slippageBps: number,
  tokenDecimals?: number,
): Promise<JupiterFill> {
  const decimals = tokenDecimals ?? (await getMintDecimals(mint));
  const sol = await solPriceUsd();
  const lamports = (usd / sol) * LAMPORTS;
  const { outAmountRaw, txHash } = await executeJupiterSwap(
    WSOL_MINT,
    mint,
    lamports,
    slippageBps,
  );
  const amountTokens = Number(outAmountRaw) / 10 ** decimals;
  return {
    priceUsd: amountTokens > 0 ? usd / amountTokens : 0,
    amountTokens,
    txHash,
  };
}

export async function jupiterSell(
  mint: string,
  amountTokens: number,
  slippageBps: number,
  tokenDecimals?: number,
): Promise<JupiterFill> {
  const decimals = tokenDecimals ?? (await getMintDecimals(mint));
  const { outAmountRaw, txHash } = await executeJupiterSwap(
    mint,
    WSOL_MINT,
    amountTokens * 10 ** decimals,
    slippageBps,
  );
  const sol = await solPriceUsd();
  const proceedsUsd = (Number(outAmountRaw) / LAMPORTS) * sol;
  return {
    priceUsd: amountTokens > 0 ? proceedsUsd / amountTokens : 0,
    amountTokens,
    proceedsUsd,
    txHash,
  };
}
