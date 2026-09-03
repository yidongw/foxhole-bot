import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeEventLog,
  getAddress,
  parseAbiItem,
  toEventSelector,
  type Address,
} from "viem";

import { writeJsonAtomic } from "../../lib/atomic-json.js";
import type { RawLog } from "../evm/log-watcher.js";

/**
 * RB 链聪明钱追踪 — 纯逻辑与持久化。
 *
 * The live wss/poll wiring lives in smart-money-watcher.ts; everything here
 * is pure and unit-tested: address book I/O, event decoding, and the
 * dual-stream (Transfer × Swap) txHash correlation that classifies a buy.
 *
 * Why two streams: a v4 `Swap` log names the pool and amounts but its
 * `sender` is the router, not the trader — it can't attribute the trade to a
 * wallet. A `Transfer(to=wallet)` log attributes but a bare transfer isn't a
 * buy (could be an airdrop / CEX withdrawal). Only when BOTH appear in the
 * same tx — the wallet received a non-quote token AND that token's pool
 * swapped — is it a confirmed on-chain buy. No receipt fetch needed.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOK_PATH = path.resolve(__dirname, "../../../data/smart-money.json");

/** Uniswap v4 singleton PoolManager on RB — every swap flows through it. */
export const RB_V4_POOL_MANAGER = getAddress(
  "0x8366a39cc670b4001a1121b8f6a443a643e40951",
);

/**
 * Quote-side currencies: a token IN of one of these is never "the buy", and
 * the quote side of a swap is what the trader spent. Mirrors v4-watcher's
 * KNOWN_QUOTES; decimals are 18 for all RB quotes seen so far.
 */
export const QUOTE_ASSETS: Record<string, { symbol: string; decimals: number }> = {
  "0x0000000000000000000000000000000000000000": { symbol: "ETH", decimals: 18 },
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73": { symbol: "WETH", decimals: 18 },
  // USDG (Global Dollar) is a 6-decimal stablecoin — verified on-chain.
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": { symbol: "USDG", decimals: 6 },
  "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544": { symbol: "LONG", decimals: 18 },
};

export function isQuoteAsset(addr: string): boolean {
  return addr.toLowerCase() in QUOTE_ASSETS;
}

// --- event ABIs & selectors ------------------------------------------------

export const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
export const TRANSFER_TOPIC0 = toEventSelector(TRANSFER_EVENT);

/** Uniswap v4 IPoolManager.Swap — id is a PoolId (keccak of the PoolKey). */
export const V4_SWAP_EVENT = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);
export const V4_SWAP_TOPIC0 = toEventSelector(V4_SWAP_EVENT);

/** v4 Initialize — maps a PoolId to its two currencies (currency0/1 indexed). */
export const V4_INITIALIZE_TOPIC0 =
  "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438" as const;

// --- address book ----------------------------------------------------------

export interface TrackedWallet {
  address: string;
  label: string;
  addedAt: string;
  addedBy?: string;
  /** Chain this wallet is tracked on. Older entries default to robinhood. */
  chain?: string;
  /** Quality tier from the winner-finder (S/A/B), optional. */
  tier?: string;
  /** Realized USD profit that qualified it (from winner-finder), optional. */
  realizedUsd?: number;
}

interface BookFile {
  wallets: TrackedWallet[];
}

/** A tracked wallet's chain, defaulting legacy (chain-less) entries to RB. */
export function walletChain(w: TrackedWallet): string {
  return (w.chain ?? "robinhood").toLowerCase();
}

/**
 * Canonical chain name for routing (Discord webhooks, signal channels, thread
 * keys) — the rest of the bot uses `solana`/`ethereum`, while GMGN uses
 * `sol`/`eth`. Normalise the short forms so smart-money routing lines up.
 */
export function canonicalChain(c: string): string {
  const s = c.toLowerCase();
  if (s === "sol") return "solana";
  if (s === "eth") return "ethereum";
  return s;
}

export async function loadTrackedWallets(): Promise<TrackedWallet[]> {
  try {
    return (JSON.parse(await readFile(BOOK_PATH, "utf8")) as BookFile).wallets;
  } catch {
    return [];
  }
}

export async function saveTrackedWallets(wallets: TrackedWallet[]): Promise<void> {
  await writeJsonAtomic(BOOK_PATH, { wallets });
}

export async function addTrackedWallet(
  address: string,
  label: string,
  addedBy?: string,
  chain = "robinhood",
): Promise<{ added: boolean; wallets: TrackedWallet[] }> {
  // Solana addresses are base58 (not 0x); only checksum EVM-style ones.
  const norm = address.startsWith("0x") ? getAddress(address) : address;
  const wallets = await loadTrackedWallets();
  if (wallets.some((w) => w.address.toLowerCase() === norm.toLowerCase())) {
    return { added: false, wallets };
  }
  wallets.push({
    address: norm,
    label,
    chain: chain.toLowerCase(),
    addedAt: new Date().toISOString(),
    addedBy,
  });
  await saveTrackedWallets(wallets);
  return { added: true, wallets };
}

export async function removeTrackedWallet(
  address: string,
): Promise<{ removed: boolean; wallets: TrackedWallet[] }> {
  const target = address.toLowerCase();
  const wallets = await loadTrackedWallets();
  const next = wallets.filter((w) => w.address.toLowerCase() !== target);
  if (next.length === wallets.length) return { removed: false, wallets };
  await saveTrackedWallets(next);
  return { removed: true, wallets: next };
}

// --- decoding --------------------------------------------------------------

export interface TransferHit {
  txHash: string;
  logIndex: number;
  token: string;
  from: string;
  to: string;
  value: bigint;
}

export interface SwapHit {
  txHash: string;
  logIndex: number;
  poolId: string;
  amount0: bigint;
  amount1: bigint;
}

/** Left-pad a 20-byte address to a 32-byte topic (for eth_getLogs filters). */
export function addressTopic(addr: string): `0x${string}` {
  return `0x${addr.toLowerCase().replace(/^0x/, "").padStart(64, "0")}` as `0x${string}`;
}

/** topics[i] is a 32-byte word holding a right-aligned 20-byte address. */
function topicToAddress(topic: `0x${string}`): string {
  return getAddress(`0x${topic.slice(26)}`);
}

export function decodeTransfer(log: RawLog): TransferHit | undefined {
  if (log.topics[0] !== TRANSFER_TOPIC0) return undefined;
  if (!log.topics[1] || !log.topics[2]) return undefined; // non-ERC20 Transfer
  try {
    return {
      txHash: log.transactionHash,
      logIndex: Number((log as { logIndex?: bigint }).logIndex ?? 0n),
      token: getAddress(log.address),
      from: topicToAddress(log.topics[1]),
      to: topicToAddress(log.topics[2]),
      value: BigInt(log.data === "0x" ? "0x0" : log.data),
    };
  } catch {
    return undefined;
  }
}

export function decodeSwap(log: RawLog): SwapHit | undefined {
  if (log.topics[0] !== V4_SWAP_TOPIC0) return undefined;
  try {
    const { args } = decodeEventLog({
      abi: [V4_SWAP_EVENT],
      data: log.data,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    });
    return {
      txHash: log.transactionHash,
      logIndex: Number((log as { logIndex?: bigint }).logIndex ?? 0n),
      poolId: (args.id as string).toLowerCase(),
      amount0: args.amount0 as bigint,
      amount1: args.amount1 as bigint,
    };
  } catch {
    return undefined;
  }
}

/** currency0/currency1 for a pool, read from its Initialize log topics. */
export function decodeInitializePair(
  log: RawLog,
): { poolId: string; currency0: string; currency1: string } | undefined {
  if (log.topics[0] !== V4_INITIALIZE_TOPIC0) return undefined;
  const [, id, c0, c1] = log.topics;
  if (!id || !c0 || !c1) return undefined;
  return {
    poolId: id.toLowerCase(),
    currency0: topicToAddress(c0),
    currency1: topicToAddress(c1),
  };
}

// --- correlation: the buy classifier ---------------------------------------

export interface PoolPair {
  currency0: string;
  currency1: string;
}

export interface DetectedBuy {
  wallet: string;
  /** Non-quote token the wallet received. */
  token: Address;
  poolId: string;
  txHash: string;
  /** Quote spent, human units (amount / 10**decimals). */
  quoteAmount: number;
  quoteSymbol: string;
}

/**
 * Pure buy classifier. Given all Transfer hits to tracked wallets and all
 * Swap hits (both keyed by txHash) plus a resolved poolId→pair map, emit one
 * DetectedBuy per (wallet, non-quote token) that is corroborated by a swap of
 * that token's pool in the same tx. Coincidental transfers with no matching
 * swap are dropped — that is the anti-false-positive lock.
 */
export function detectBuys(
  transfers: TransferHit[],
  swaps: SwapHit[],
  poolPair: Map<string, PoolPair>,
  trackedWallets: Set<string>,
): DetectedBuy[] {
  const swapByTx = new Map<string, SwapHit[]>();
  for (const s of swaps) {
    const list = swapByTx.get(s.txHash) ?? [];
    list.push(s);
    swapByTx.set(s.txHash, list);
  }

  const out: DetectedBuy[] = [];
  const seen = new Set<string>();
  for (const t of transfers) {
    if (!trackedWallets.has(t.to.toLowerCase())) continue;
    if (isQuoteAsset(t.token)) continue; // received quote = change/refund, not a buy
    const candidateSwaps = swapByTx.get(t.txHash);
    if (!candidateSwaps) continue;

    const tokenLc = t.token.toLowerCase();
    for (const s of candidateSwaps) {
      const pair = poolPair.get(s.poolId);
      if (!pair) continue;
      const c0 = pair.currency0.toLowerCase();
      const c1 = pair.currency1.toLowerCase();
      if (c0 !== tokenLc && c1 !== tokenLc) continue; // swap isn't for this token

      // The quote side is whichever pool currency is a known quote asset.
      const quoteAddr = isQuoteAsset(c0) ? c0 : isQuoteAsset(c1) ? c1 : undefined;
      const quoteMeta = quoteAddr ? QUOTE_ASSETS[quoteAddr] : undefined;
      const quoteRaw =
        quoteAddr === c0 ? s.amount0 : quoteAddr === c1 ? s.amount1 : 0n;
      const decimals = quoteMeta?.decimals ?? 18;
      const quoteAmount =
        Number(quoteRaw < 0n ? -quoteRaw : quoteRaw) / 10 ** decimals;

      const dedupKey = `${t.txHash}:${t.to.toLowerCase()}:${tokenLc}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      out.push({
        wallet: t.to,
        token: t.token as Address,
        poolId: s.poolId,
        txHash: t.txHash,
        quoteAmount,
        quoteSymbol: quoteMeta?.symbol ?? "?",
      });
      break;
    }
  }
  return out;
}

// --- conviction: N distinct wallets into one token within a window ----------

interface ConvictionEntry {
  wallet: string;
  at: number;
}

/**
 * Tracks recent buys per token so we can escalate from "alert" to "feed the
 * signal pipeline" once ≥N *distinct* tracked wallets buy the same token
 * inside the window. `now` is injectable for deterministic tests.
 */
export class ConvictionTracker {
  private byToken = new Map<string, ConvictionEntry[]>();
  constructor(private windowMs: number) {}

  /** Record a buy; return the count of distinct wallets in the live window. */
  record(token: string, wallet: string, now: number): number {
    const key = token.toLowerCase();
    const cutoff = now - this.windowMs;
    const kept = (this.byToken.get(key) ?? []).filter((e) => e.at > cutoff);
    kept.push({ wallet: wallet.toLowerCase(), at: now });
    this.byToken.set(key, kept);
    return new Set(kept.map((e) => e.wallet)).size;
  }

  /** Distinct wallets currently in-window for a token (no mutation). */
  distinct(token: string, now: number): number {
    const cutoff = now - this.windowMs;
    const kept = (this.byToken.get(token.toLowerCase()) ?? []).filter(
      (e) => e.at > cutoff,
    );
    return new Set(kept.map((e) => e.wallet)).size;
  }
}
