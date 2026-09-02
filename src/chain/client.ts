import { type Address, type PublicClient, erc20Abi } from "viem";
import { createHoodClient, getQuote } from "hoodchain";
import { LONG_AIRLOCK } from "../long/constants.js";

export function getRpcUrl(): string {
  return (
    process.env.ROBINHOOD_RPC ??
    "https://rpc.mainnet.chain.robinhood.com"
  );
}

let hoodClient: ReturnType<typeof createHoodClient> | undefined;

function getHoodClient() {
  if (!hoodClient) {
    hoodClient = createHoodClient({ rpcUrl: getRpcUrl() });
  }
  return hoodClient;
}

/** Raw viem public client for log queries and reads. */
export function getPublicClient(): PublicClient {
  return getHoodClient().public as unknown as PublicClient;
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

export { LONG_AIRLOCK };
