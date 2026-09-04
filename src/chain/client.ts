import {
  createPublicClient,
  fallback,
  http,
  type Address,
  type PublicClient,
  type Transport,
  erc20Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createHoodClient, getQuote } from "hoodchain";
import { LONG_AIRLOCK } from "../long/constants.js";

export const PUBLIC_RB_RPC = "https://rpc.mainnet.chain.robinhood.com";

export function getRpcUrl(): string {
  return process.env.ROBINHOOD_RPC ?? PUBLIC_RB_RPC;
}

/**
 * Primary RPC with automatic fallback to the public endpoint. When the
 * primary is a metered key (Alchemy), exhausting the monthly quota must NOT
 * blind the engine again (2026-09-03: capped key + no fallback = days of dead
 * on-chain discovery) — viem's fallback transport shifts traffic to the
 * public RPC on errors and keeps retrying the primary.
 */
export function getRbTransport(): Transport {
  const primary = getRpcUrl();
  if (primary === PUBLIC_RB_RPC) return http(primary);
  return fallback([http(primary), http(PUBLIC_RB_RPC)]);
}

let hoodClient: ReturnType<typeof createHoodClient> | undefined;

function getHoodClient() {
  if (!hoodClient) {
    hoodClient = createHoodClient({ transport: getRbTransport() });
  }
  return hoodClient;
}

let tradingClient: ReturnType<typeof createHoodClient> | undefined;

/**
 * Wallet-enabled hood client for live swaps. Requires TRADER_PRIVATE_KEY.
 * Never construct this in paper mode.
 */
export function getTradingClient(): ReturnType<typeof createHoodClient> {
  if (!tradingClient) {
    const pk = process.env.TRADER_PRIVATE_KEY;
    if (!pk) {
      throw new Error("TRADER_PRIVATE_KEY not set — live trading unavailable");
    }
    tradingClient = createHoodClient({
      transport: getRbTransport(),
      account: privateKeyToAccount(pk as `0x${string}`),
    });
  }
  return tradingClient;
}

/** Raw viem public client for log queries and reads. */
export function getPublicClient(): PublicClient {
  return getHoodClient().public as unknown as PublicClient;
}

let logsClient: PublicClient | undefined;

/**
 * Client for eth_getLogs: Alchemy's free tier caps log queries at 10 blocks,
 * so log scans go through the public RPC (10k-block ranges OK, just rate
 * limited — the chunked fetcher paces itself). Override: ROBINHOOD_LOGS_RPC.
 */
export function getLogsClient(): PublicClient {
  if (!logsClient) {
    logsClient = createPublicClient({
      transport: http(
        process.env.ROBINHOOD_LOGS_RPC ?? "https://rpc.mainnet.chain.robinhood.com",
        { retryCount: 4, retryDelay: 1500 },
      ),
    });
  }
  return logsClient;
}

export async function getErc20Symbol(token: Address): Promise<string | undefined> {
  try {
    return await getHoodClient().public.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "symbol",
    });
  } catch {
    return undefined;
  }
}

export async function getErc20Balance(
  token: Address,
  holder: Address,
): Promise<bigint> {
  return getHoodClient().public.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  });
}

export async function getErc20TotalSupply(token: Address): Promise<bigint> {
  return getHoodClient().public.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "totalSupply",
  });
}

export async function getStockOracleUsd(symbol: string): Promise<number | undefined> {
  try {
    const quote = await getQuote(getHoodClient(), symbol.toUpperCase());
    return quote.priceUsd;
  } catch {
    return undefined;
  }
}

/**
 * Wait for a receipt tolerating RB's flaky public RPC. Its nodes intermittently
 * throw "Block at number … could not be found" while polling, which viem's
 * waitForTransactionReceipt surfaces as an error — and a swap caller that treats
 * that as "tx failed" will retry and DOUBLE-BUY even though the first swap landed
 * (real incident: SHROOM, 2026-09-04). Since the tx is already broadcast, we poll
 * getTransactionReceipt ourselves, swallowing transient errors, until it appears
 * or the deadline passes. Only a genuine timeout throws.
 */
export async function waitForReceiptResilient(
  client: { getTransactionReceipt: (a: { hash: `0x${string}` }) => Promise<{ status: "success" | "reverted" }> },
  hash: `0x${string}`,
  timeoutMs = 120_000,
): Promise<{ status: "success" | "reverted" }> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const r = await client.getTransactionReceipt({ hash });
      if (r) return r;
    } catch (err) {
      lastErr = err; // not mined yet / transient RB "block not found" — keep polling
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw lastErr ?? new Error(`receipt timeout for ${hash}`);
}

export { LONG_AIRLOCK };
