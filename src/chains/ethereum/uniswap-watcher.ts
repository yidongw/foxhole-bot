import { erc20Abi, getAddress, type Address } from "viem";

import { getEvmClient } from "../evm/clients.js";
import { fetchLogsChunked } from "../evm/log-watcher.js";

/**
 * ETH mainnet new-pair monitor (monitor-only by design — fresh ETH pairs are
 * rug-dominated; execution stays disabled until signal quality is proven).
 */

export const UNISWAP_V2_FACTORY =
  "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f" as const;
export const UNISWAP_V3_FACTORY =
  "0x1F98431c8aD98523631AE4a59f267346ea31F984" as const;
export const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;

/** keccak("PairCreated(address,address,address,uint256)") — verified live. */
export const PAIR_CREATED_TOPIC0 =
  "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9" as const;
/** keccak("PoolCreated(address,address,uint24,int24,address)") — verified live. */
export const POOL_CREATED_TOPIC0 =
  "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118" as const;

export interface NewEthPair {
  token: Address;
  version: "v2" | "v3";
  blockNumber: bigint;
}

function topicToAddress(topic: `0x${string}`): Address {
  return getAddress(`0x${topic.slice(26)}`);
}

/** New WETH-paired tokens from both Uniswap factories in a block range. */
export async function fetchNewWethPairs(
  fromBlock: bigint,
  toBlock: bigint,
): Promise<NewEthPair[]> {
  const client = getEvmClient("ethereum");
  const pairs: NewEthPair[] = [];

  for (const [factory, topic0, version] of [
    [UNISWAP_V2_FACTORY, PAIR_CREATED_TOPIC0, "v2"],
    [UNISWAP_V3_FACTORY, POOL_CREATED_TOPIC0, "v3"],
  ] as const) {
    const logs = await fetchLogsChunked(client, {
      address: factory,
      topics: [topic0],
      fromBlock,
      toBlock,
      chunkSize: 2_000n,
      chunkDelayMs: 400,
    });
    for (const log of logs) {
      if (!log.topics[1] || !log.topics[2]) continue;
      const token0 = topicToAddress(log.topics[1]);
      const token1 = topicToAddress(log.topics[2]);
      const other =
        token0 === WETH ? token1 : token1 === WETH ? token0 : undefined;
      if (!other) continue; // non-WETH pairs are mostly stable/exotic churn
      pairs.push({ token: other, version, blockNumber: log.blockNumber });
    }
  }
  return pairs;
}

export async function getEthLatestBlock(): Promise<bigint> {
  return getEvmClient("ethereum").getBlockNumber();
}

export async function formatEthPairDigest(pairs: NewEthPair[]): Promise<string> {
  const client = getEvmClient("ethereum");
  const symbols: string[] = [];
  for (const p of pairs.slice(0, 6)) {
    try {
      symbols.push(
        await client.readContract({
          address: p.token,
          abi: erc20Abi,
          functionName: "symbol",
        }),
      );
    } catch {
      symbols.push(p.token.slice(0, 8));
    }
  }
  const lines = [
    `⟠ **New Uniswap WETH pairs [ETH]**: ${pairs.length} (${pairs.filter((p) => p.version === "v2").length} v2 / ${pairs.filter((p) => p.version === "v3").length} v3)`,
  ];
  if (symbols.length) lines.push(symbols.join(", "));
  return lines.join("\n");
}
