import { type Address, erc20Abi } from "viem";
import { createPublicClient, http, type PublicClient } from "viem";
import { createHoodClient, getQuote } from "hoodchain";
import { LONG_AIRLOCK, ROBINHOOD_CHAIN_ID, DEFAULT_PUBLIC_RPC } from "../long/constants.js";

export function getRpcUrl(): string {
  return process.env.ROBINHOOD_RPC ?? DEFAULT_PUBLIC_RPC;
}

const robinhood = {
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [getRpcUrl()] },
    public: { http: [getRpcUrl()] },
  },
} as const;

export function createRobinhoodPublicClient(): PublicClient {
  return createPublicClient({
    chain: robinhood,
    transport: http(getRpcUrl()),
  });
}

let hoodClient: ReturnType<typeof createHoodClient> | undefined;

function getHoodClient() {
  if (!hoodClient) {
    hoodClient = createHoodClient({ rpcUrl: getRpcUrl() });
  }
  return hoodClient;
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

export { LONG_AIRLOCK };
