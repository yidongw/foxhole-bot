import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { createJupiterApiClient } from "@jup-ag/api";

import { fetchTokenPriceUsd } from "../../dex/dexscreener.js";
import { getSolanaConnection } from "./pumpfun.js";

/**
 * Jupiter swap execution via the free lite API (no key).
 * ⚠️ UNTESTED WITH REAL FUNDS — paper-trade first; live requires
 * SOLANA_PRIVATE_KEY (base58 or JSON byte array) on a throwaway wallet.
 */

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS = 1_000_000_000;

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

  const swap = await jupiter.swapPost({
    swapRequest: {
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      dynamicComputeUnitLimit: true,
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
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    { signature: txHash, ...latest },
    "confirmed",
  );
  return { outAmountRaw: BigInt(quote.outAmount), txHash };
}

/** Buy `usd` worth of `mint` with SOL. Assumes 6-decimal pump-style mints unless overridden. */
export async function jupiterBuy(
  mint: string,
  usd: number,
  slippageBps: number,
  tokenDecimals = 6,
): Promise<JupiterFill> {
  const sol = await solPriceUsd();
  const lamports = (usd / sol) * LAMPORTS;
  const { outAmountRaw, txHash } = await executeJupiterSwap(
    WSOL_MINT,
    mint,
    lamports,
    slippageBps,
  );
  const amountTokens = Number(outAmountRaw) / 10 ** tokenDecimals;
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
  tokenDecimals = 6,
): Promise<JupiterFill> {
  const { outAmountRaw, txHash } = await executeJupiterSwap(
    mint,
    WSOL_MINT,
    amountTokens * 10 ** tokenDecimals,
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
