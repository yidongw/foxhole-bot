import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeAbiParameters,
  formatUnits,
  getAddress,
  parseAbi,
  type Address,
} from "viem";

import { getEvmClient } from "../evm/clients.js";
import { fetchLogsChunked, type RawLog } from "../evm/log-watcher.js";
import { writeJsonAtomic } from "../../lib/atomic-json.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

/**
 * Four.meme bonding-curve state reader — the BSC analogue of pump.fun's
 * getPumpCurveState, giving BSC a *pre-pump* signal source (curve nearing
 * graduation) rather than only lagging DexScreener momentum.
 *
 * TokenManagerHelper3 (V3, covers V1+V2 tokens). getTokenInfo signature and
 * the funds/maxFunds progress semantics verified live on BSC 2026-09-03:
 * on-curve tokens return version=2 with liquidityAdded=false and funds rising
 * toward maxFunds; non-four.meme tokens return version=0/maxFunds=0 (no
 * revert); graduation flips liquidityAdded=true once the PancakeSwap pair is
 * created.
 */
export const FOURMEME_HELPER =
  "0xF251F83e40a78868FcfA3FA4599Dad6494E46034" as const;

const HELPER_ABI = parseAbi([
  "function getTokenInfo(address token) view returns (uint256 version, address tokenManager, address quote, uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee, uint256 launchTime, uint256 offers, uint256 maxOffers, uint256 funds, uint256 maxFunds, bool liquidityAdded)",
]);

export interface FourmemeCurveState {
  isFourmemeToken: boolean;
  graduated?: boolean;
  /** 0..1 fraction of the BNB/quote raise target reached (graduation at 1). */
  progress?: number;
  /** BNB (or quote) raised so far — real curve depth DexScreener omits. */
  fundsRaised?: number;
}

/** Pure: BNB raised as a fraction of the graduation target, clamped 0..1. */
export function fourmemeCurveProgress(
  funds: bigint,
  maxFunds: bigint,
): number | undefined {
  if (maxFunds <= 0n) return undefined;
  const p = Number(funds) / Number(maxFunds);
  return Math.min(Math.max(p, 0), 1);
}

export async function getFourmemeCurveState(
  token: string,
): Promise<FourmemeCurveState> {
  let addr: Address;
  try {
    addr = getAddress(token);
  } catch {
    return { isFourmemeToken: false };
  }
  try {
    const [version, , , , , , , , , funds, maxFunds, liquidityAdded] =
      await getEvmClient("bsc").readContract({
        address: FOURMEME_HELPER,
        abi: HELPER_ABI,
        functionName: "getTokenInfo",
        args: [addr],
      });
    // Non-four.meme tokens answer with an empty record rather than reverting.
    if (version === 0n && maxFunds === 0n) return { isFourmemeToken: false };
    return {
      isFourmemeToken: true,
      graduated: liquidityAdded,
      progress: fourmemeCurveProgress(funds, maxFunds),
      fundsRaised: Number(formatUnits(funds, 18)),
    };
  } catch {
    return { isFourmemeToken: false };
  }
}

export function formatFourmemeDigest(launches: FourmemeLaunch[]): string {
  const sample = launches.slice(0, 8).map((l) => l.symbol || l.name || "?");
  const lines = [`🍀 **Four.meme launches [BSC]**: ${launches.length} new`];
  if (sample.length) lines.push(sample.join(", "));
  return lines.join("\n");
}

/**
 * Four.meme launch watcher — the BSC analogue of the RB v4-watcher probation
 * pipeline. A raw TokenCreate digest tells you a token was *minted*, but
 * four.meme tokens start on a bonding curve and only get a real DexScreener-
 * indexed PancakeSwap pool once they gain traction (≈graduation). Freshly
 * minted addresses go to a probation list; once DexScreener indexes them on
 * BSC with liquidity ≥ threshold they graduate to verified tracking and get
 * analyzed + signal-graded each tick (the squeeze-radar moment), tracked for
 * a bounded window and capped by recency.
 */
const WATCH_PATH = path.resolve(__dirname, "../../../data/fourmeme-watch.json");

export interface FourmemeWatchEntry {
  address: string;
  symbol?: string;
  firstSeen: string;
  /** DexScreener-indexed on BSC with real liquidity → analyzed each tick. */
  verified: boolean;
  attempts: number;
}

interface FourmemeWatchFile {
  entries: FourmemeWatchEntry[];
}

export const FOURMEME_TRACK_HOURS = 12;
export const FOURMEME_MAX_TRACKED = 40;
export const FOURMEME_MIN_LIQUIDITY_USD = 15_000;
const MAX_ATTEMPTS = 8;

export async function loadFourmemeWatch(): Promise<FourmemeWatchEntry[]> {
  try {
    return (JSON.parse(await readFile(WATCH_PATH, "utf8")) as FourmemeWatchFile)
      .entries;
  } catch {
    return [];
  }
}

export async function saveFourmemeWatch(
  entries: FourmemeWatchEntry[],
): Promise<void> {
  // expire; verified capped at FOURMEME_MAX_TRACKED (analyzed each tick),
  // probation capped separately (cheap batch checks only)
  const cutoff = Date.now() - FOURMEME_TRACK_HOURS * 3_600_000;
  const alive = entries.filter(
    (e) =>
      new Date(e.firstSeen).getTime() > cutoff &&
      (e.verified || e.attempts < MAX_ATTEMPTS),
  );
  const verified = alive
    .filter((e) => e.verified)
    .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))
    .slice(0, FOURMEME_MAX_TRACKED);
  const probation = alive
    .filter((e) => !e.verified)
    .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))
    .slice(0, 400);
  await writeJsonAtomic(WATCH_PATH, { entries: [...verified, ...probation] });
}

/** Merge freshly-minted launches onto the probation list; returns # added. */
export async function addFourmemeProbation(
  launches: FourmemeLaunch[],
  entries: FourmemeWatchEntry[],
): Promise<number> {
  const seen = new Set(entries.map((e) => e.address.toLowerCase()));
  let added = 0;
  for (const l of launches) {
    if (seen.has(l.token.toLowerCase())) continue;
    entries.push({
      address: l.token,
      symbol: l.symbol || l.name || undefined,
      firstSeen: new Date().toISOString(),
      verified: false,
      attempts: 0,
    });
    seen.add(l.token.toLowerCase());
    added++;
  }
  return added;
}

/**
 * Cheap probation screening: batch DexScreener token lookups (30 addrs per
 * request) → BSC liquidity ≥ threshold graduates to verified tracking.
 * Mirrors the RB v4-watcher's screenProbation, filtered to chainId "bsc".
 */
export async function screenFourmemeProbation(
  entries: FourmemeWatchEntry[],
  batchLimit = 5,
): Promise<number> {
  const probation = entries.filter((e) => !e.verified);
  let promoted = 0;
  for (let i = 0; i < probation.length && i / 30 < batchLimit; i += 30) {
    const batch = probation.slice(i, i + 30);
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${batch.map((e) => e.address).join(",")}`,
        { headers: { "User-Agent": "foxhole-bot/0.3" } },
      );
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        pairs?: Array<{
          chainId: string;
          baseToken?: { address?: string };
          liquidity?: { usd?: number };
        }>;
      };
      const liqByAddr = new Map<string, number>();
      for (const p of data.pairs ?? []) {
        if (p.chainId !== "bsc") continue;
        const a = p.baseToken?.address?.toLowerCase();
        if (!a) continue;
        liqByAddr.set(
          a,
          Math.max(liqByAddr.get(a) ?? 0, Number(p.liquidity?.usd ?? 0)),
        );
      }
      for (const e of batch) {
        const liq = liqByAddr.get(e.address.toLowerCase()) ?? 0;
        if (liq >= FOURMEME_MIN_LIQUIDITY_USD) {
          e.verified = true;
          promoted++;
        } else {
          e.attempts++;
        }
      }
    } catch {
      // batch failed — retry next tick without burning attempts
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return promoted;
}
