import type { Address, PublicClient } from "viem";

import { sleep } from "../../lib/utils.js";

/** Minimal log shape from raw eth_getLogs. */
export interface RawLog {
  address: Address;
  topics: `0x${string}`[];
  data: `0x${string}`;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
}

export interface FetchLogsOptions {
  address: Address;
  topics?: (`0x${string}` | null)[];
  fromBlock: bigint;
  toBlock: bigint;
  /** Initial block span; halves on RPC errors (public RPCs cap ranges). */
  chunkSize?: bigint;
  chunkDelayMs?: number;
}

interface RpcLog {
  address: Address;
  topics: `0x${string}`[];
  data: `0x${string}`;
  blockNumber: `0x${string}`;
  transactionHash: `0x${string}`;
}

/**
 * Chunked eth_getLogs with backoff.
 *
 * Uses the raw RPC method instead of viem's `getLogs` because viem strips an
 * unknown `topics` param (it only accepts ABI `event` filters) — the topic
 * filter would silently not apply and every event type would come back.
 */
export async function fetchLogsChunked(
  client: PublicClient,
  options: FetchLogsOptions,
): Promise<RawLog[]> {
  const delay = options.chunkDelayMs ?? 300;
  let chunk = options.chunkSize ?? 2_000n;
  const out: RawLog[] = [];

  let from = options.fromBlock;
  while (from <= options.toBlock) {
    const to =
      from + chunk - 1n > options.toBlock ? options.toBlock : from + chunk - 1n;
    try {
      const logs = (await client.request({
        method: "eth_getLogs",
        params: [
          {
            address: options.address,
            ...(options.topics ? { topics: options.topics } : {}),
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
          },
        ],
      })) as RpcLog[];
      for (const log of logs) {
        out.push({
          address: log.address,
          topics: log.topics,
          data: log.data,
          blockNumber: BigInt(log.blockNumber),
          transactionHash: log.transactionHash,
        });
      }
      from = to + 1n;
      await sleep(delay);
    } catch (err) {
      if (chunk > 100n) {
        chunk /= 2n;
        await sleep(delay * 4);
        continue;
      }
      throw new Error(
        `getLogs failed at block ${from}: ${(err as Error).message}`,
      );
    }
  }
  return out;
}
