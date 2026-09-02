import { decodeAbiParameters, getAddress, type Address } from "viem";

import { getEvmClient } from "../evm/clients.js";
import { fetchLogsChunked, type RawLog } from "../evm/log-watcher.js";

/** Four.meme TokenManager2 on BSC (chain 56). */
export const FOURMEME_TOKEN_MANAGER =
  "0x5c952063c7fc8610FFDB798152D69F0B9550762b" as const;

/**
 * topic0 of Four.meme's TokenCreate event, verified on BSC 2026-09-02
 * (54 events / 5k blocks; sample decodes with name+symbol strings).
 * Layout (all non-indexed):
 *   (address creator, address token, uint256 requestId, string name,
 *    string symbol, uint256 totalSupply, uint256 launchTime, uint256 launchFee)
 */
export const FOURMEME_TOKEN_CREATE_TOPIC0 =
  "0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20" as const;

/** Observed trade topics (per-event meaning unverified; used for activity counts only). */
export const FOURMEME_PURCHASE_TOPIC0 =
  "0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942" as const;
export const FOURMEME_SALE_TOPIC0 =
  "0x0a5575b3648bae2210cee56bf33254cc1ddfbc7bf637c0af2ac18b14fb1bae19" as const;

const CREATE_PARAMS = [
  { type: "address" }, // creator
  { type: "address" }, // token
  { type: "uint256" }, // requestId
  { type: "string" }, // name
  { type: "string" }, // symbol
  { type: "uint256" }, // totalSupply
  { type: "uint256" }, // launchTime
  { type: "uint256" }, // launchFee
] as const;

export interface FourmemeLaunch {
  creator: Address;
  token: Address;
  name: string;
  symbol: string;
  totalSupply: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

export function decodeTokenCreate(
  log: Pick<RawLog, "data" | "blockNumber" | "transactionHash">,
): FourmemeLaunch {
  const [creator, token, , name, symbol, totalSupply] = decodeAbiParameters(
    CREATE_PARAMS,
    log.data,
  );
  return {
    creator: getAddress(creator),
    token: getAddress(token),
    name,
    symbol,
    totalSupply,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
  };
}

export async function fetchFourmemeLaunches(
  fromBlock: bigint,
  toBlock: bigint,
): Promise<FourmemeLaunch[]> {
  const logs = await fetchLogsChunked(getEvmClient("bsc"), {
    address: FOURMEME_TOKEN_MANAGER,
    topics: [FOURMEME_TOKEN_CREATE_TOPIC0],
    fromBlock,
    toBlock,
    chunkSize: 500n, // publicnode caps getLogs ranges tightly
    chunkDelayMs: 300,
  });
  const launches: FourmemeLaunch[] = [];
  for (const log of logs) {
    try {
      launches.push(decodeTokenCreate(log));
    } catch (err) {
      console.error("fourmeme decode failed:", (err as Error).message);
    }
  }
  return launches;
}

export async function getBscLatestBlock(): Promise<bigint> {
  return getEvmClient("bsc").getBlockNumber();
}

export function formatFourmemeDigest(launches: FourmemeLaunch[]): string {
  const sample = launches.slice(0, 8).map((l) => l.symbol || l.name || "?");
  const lines = [`🍀 **Four.meme launches [BSC]**: ${launches.length} new`];
  if (sample.length) lines.push(sample.join(", "));
  return lines.join("\n");
}
