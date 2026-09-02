import {
  decodeAbiParameters,
  getAddress,
  padHex,
  type Address,
  type Log,
} from "viem";

import { getErc20Symbol, getPublicClient } from "../chain/client.js";
import { LONG_CREATED_TOPIC0, LONG_FACTORY } from "./constants.js";
import { sleep } from "../lib/utils.js";

/** A decoded Long.xyz factory launch event. */
export interface FactoryLaunch {
  token: Address;
  /** The asset the token graduates against (stock token, USDG, or another meme). */
  pairToken: Address;
  pairSymbol?: string;
  symbol: string;
  auctionNumeraire: Address;
  hook: Address;
  auctionPoolId: `0x${string}`;
  epochStart: string;
  epochEnd: string;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

const DATA_PARAMS = [
  { type: "address" }, // auction numeraire (constant per deployment)
  { type: "address" }, // v4 hook
  { type: "bytes32" }, // auction pool id
  { type: "uint256" }, // epoch start (unix)
  { type: "uint256" }, // epoch end (unix)
  { type: "string" }, // token symbol
] as const;

export function decodeCreatedLog(log: Log): FactoryLaunch {
  if (!log.topics[1] || !log.topics[3]) {
    throw new Error(`Created log missing topics: ${log.transactionHash}`);
  }
  const [auctionNumeraire, hook, auctionPoolId, epochStart, epochEnd, symbol] =
    decodeAbiParameters(DATA_PARAMS, log.data);
  return {
    token: getAddress(`0x${log.topics[1].slice(26)}`),
    pairToken: getAddress(`0x${log.topics[3].slice(26)}`),
    symbol,
    auctionNumeraire,
    hook,
    auctionPoolId,
    epochStart: new Date(Number(epochStart) * 1000).toISOString(),
    epochEnd: new Date(Number(epochEnd) * 1000).toISOString(),
    blockNumber: log.blockNumber ?? 0n,
    txHash: log.transactionHash ?? "0x",
  };
}

const pairSymbolCache = new Map<string, string | undefined>();

async function resolvePairSymbol(address: Address): Promise<string | undefined> {
  const key = address.toLowerCase();
  if (!pairSymbolCache.has(key)) {
    pairSymbolCache.set(key, await getErc20Symbol(address));
  }
  return pairSymbolCache.get(key);
}

export interface FetchCreatedOptions {
  fromBlock: bigint;
  toBlock: bigint;
  /** Only launches for this token address. */
  token?: Address;
  /** Initial getLogs block span; halves on RPC errors. */
  chunkSize?: bigint;
  /** Delay between chunk requests (public RPC is rate limited). */
  chunkDelayMs?: number;
  resolveSymbols?: boolean;
}

/** Fetch and decode factory launch events over a block range, chunked with backoff. */
export async function fetchCreatedEvents(
  options: FetchCreatedOptions,
): Promise<FactoryLaunch[]> {
  const client = getPublicClient();
  const delay = options.chunkDelayMs ?? 400;
  let chunk = options.chunkSize ?? 10_000n;
  const launches: FactoryLaunch[] = [];

  let from = options.fromBlock;
  while (from <= options.toBlock) {
    const to =
      from + chunk - 1n > options.toBlock ? options.toBlock : from + chunk - 1n;
    try {
      const logs = await client.getLogs({
        address: LONG_FACTORY,
        fromBlock: from,
        toBlock: to,
        // topic filter keeps responses small on the rate-limited public RPC
        ...(options.token
          ? { topics: [LONG_CREATED_TOPIC0, padHex(options.token, { size: 32 })] }
          : { topics: [LONG_CREATED_TOPIC0] }),
      } as Parameters<typeof client.getLogs>[0]);
      for (const log of logs) {
        try {
          launches.push(decodeCreatedLog(log));
        } catch (err) {
          console.error("failed to decode Created log:", (err as Error).message);
        }
      }
      from = to + 1n;
      await sleep(delay);
    } catch (err) {
      if (chunk > 1_000n) {
        chunk /= 2n;
        await sleep(delay * 4);
        continue;
      }
      throw new Error(
        `factory getLogs failed at block ${from}: ${(err as Error).message}`,
      );
    }
  }

  if (options.resolveSymbols ?? true) {
    for (const l of launches) {
      l.pairSymbol = await resolvePairSymbol(l.pairToken);
      await sleep(150);
    }
  }
  return launches;
}

export async function getLatestBlock(): Promise<bigint> {
  return getPublicClient().getBlockNumber();
}

export function formatLaunchAlert(l: FactoryLaunch): string {
  const pair = l.pairSymbol ?? l.pairToken.slice(0, 10);
  return [
    `🚀 **NEW LONG.XYZ LAUNCH** — ${l.symbol}/${pair}`,
    `Epoch: ${l.epochStart} → ${l.epochEnd}`,
    `Token: \`${l.token}\``,
    `Long: https://app.long.xyz/tokens/${l.token}`,
    `Explorer: https://robinhoodchain.blockscout.com/token/${l.token}`,
  ].join("\n");
}
