import { createPublicClient, http, type PublicClient } from "viem";
import { base, bsc, mainnet } from "viem/chains";

import type { ChainId } from "../adapter.js";

/** Public RPC defaults; override per chain with {BSC,BASE,ETH}_RPC env vars. */
const RPC_DEFAULTS: Partial<Record<ChainId, { url: string; envVar: string }>> = {
  bsc: { url: "https://bsc.publicnode.com", envVar: "BSC_RPC" },
  // publicnode gates Base getLogs behind a token; the official RPC allows it
  base: { url: "https://mainnet.base.org", envVar: "BASE_RPC" },
  ethereum: { url: "https://ethereum.publicnode.com", envVar: "ETH_RPC" },
};

const VIEM_CHAINS = { bsc, base, ethereum: mainnet } as const;

const clients = new Map<ChainId, PublicClient>();

export function getEvmClient(chainId: ChainId): PublicClient {
  const def = RPC_DEFAULTS[chainId];
  if (!def) throw new Error(`no EVM client config for ${chainId}`);
  if (!clients.has(chainId)) {
    clients.set(
      chainId,
      createPublicClient({
        chain: VIEM_CHAINS[chainId as keyof typeof VIEM_CHAINS],
        transport: http(process.env[def.envVar] ?? def.url, {
          retryCount: 4,
          retryDelay: 1500,
        }),
      }) as PublicClient,
    );
  }
  return clients.get(chainId)!;
}
