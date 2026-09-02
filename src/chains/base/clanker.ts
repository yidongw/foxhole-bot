import { decodeEventLog, parseAbiItem, type Address } from "viem";

import { getEvmClient } from "../evm/clients.js";
import { fetchLogsChunked, type RawLog } from "../evm/log-watcher.js";

/** Clanker v4 factory on Base (mined from clanker-sdk v4.2.19, MIT). */
export const CLANKER_V4_FACTORY =
  "0xE85A59c628F7d27878ACeB4bf3b35733630083a9" as const;

/** Verified on Base mainnet 2026-09-02 (live logs decode). */
export const CLANKER_TOKEN_CREATED_TOPIC0 =
  "0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67" as const;

const TOKEN_CREATED_EVENT = parseAbiItem(
  "event TokenCreated(address msgSender, address indexed tokenAddress, address indexed tokenAdmin, string tokenImage, string tokenName, string tokenSymbol, string tokenMetadata, string tokenContext, int24 startingTick, address poolHook, bytes32 poolId, address pairedToken, address locker, address mevModule, uint256 extensionsSupply, address[] extensions)",
);

export interface ClankerLaunch {
  token: Address;
  admin: Address;
  name: string;
  symbol: string;
  pairedToken: Address;
  poolId: `0x${string}`;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

export function decodeClankerCreated(
  log: Pick<RawLog, "data" | "topics" | "blockNumber" | "transactionHash">,
): ClankerLaunch {
  const { args } = decodeEventLog({
    abi: [TOKEN_CREATED_EVENT],
    data: log.data,
    topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
  });
  return {
    token: args.tokenAddress,
    admin: args.tokenAdmin,
    name: args.tokenName,
    symbol: args.tokenSymbol,
    pairedToken: args.pairedToken,
    poolId: args.poolId,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
  };
}

export async function fetchClankerLaunches(
  fromBlock: bigint,
  toBlock: bigint,
): Promise<ClankerLaunch[]> {
  const logs = await fetchLogsChunked(getEvmClient("base"), {
    address: CLANKER_V4_FACTORY,
    topics: [CLANKER_TOKEN_CREATED_TOPIC0],
    fromBlock,
    toBlock,
    chunkSize: 3_000n,
    chunkDelayMs: 400,
  });
  const launches: ClankerLaunch[] = [];
  for (const log of logs) {
    try {
      launches.push(decodeClankerCreated(log));
    } catch (err) {
      console.error("clanker decode failed:", (err as Error).message);
    }
  }
  return launches;
}

export async function getBaseLatestBlock(): Promise<bigint> {
  return getEvmClient("base").getBlockNumber();
}

export function formatClankerDigest(launches: ClankerLaunch[]): string {
  const sample = launches.slice(0, 8).map((l) => l.symbol || l.name || "?");
  const lines = [`🔵 **Clanker launches [BASE]**: ${launches.length} new`];
  if (sample.length) lines.push(sample.join(", "));
  return lines.join("\n");
}
