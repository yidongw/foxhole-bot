import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  webSocket,
  type Address,
  type Log,
} from "viem";

import { getErc20Symbol, getLogsClient } from "../../chain/client.js";
import { writeJsonAtomic } from "../../lib/atomic-json.js";
import { sleep } from "../../lib/utils.js";
import { fetchLogsChunked, type RawLog } from "../evm/log-watcher.js";
import { smartMoneyEngine, type SmartMoneyBuy } from "../../smartmoney/engine.js";
import {
  QUOTE_ASSETS,
  RB_V4_POOL_MANAGER,
  TRANSFER_EVENT,
  TRANSFER_TOPIC0,
  V4_INITIALIZE_TOPIC0,
  V4_SWAP_EVENT,
  V4_SWAP_TOPIC0,
  addressTopic,
  decodeInitializePair,
  decodeSwap,
  decodeTransfer,
  detectBuys,
  loadActiveTrackedWallets,
  walletChain,
  type DetectedBuy,
  type PoolPair,
  type SwapHit,
  type TransferHit,
} from "./smart-money.js";

/** Quote symbols that are USD stablecoins → quote amount ≈ USD. */
const STABLE_QUOTES = new Set(["USDG"]);

/**
 * RB 链聪明钱实时 watcher.
 *
 * Push mode (ROBINHOOD_WSS set): two eth_subscribe streams — v4 Swap logs and
 * Transfer(to=tracked) logs — buffered by txHash and correlated within a short
 * window for sub-second alerts. Poll mode (default): getLogs both event types
 * each tick and correlate the whole batch. Detection core is shared.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(__dirname, "../../../data/smart-money-state.json");

const RELOAD_MS = 30_000; // re-read the address book this often
const FLUSH_MS = Number(process.env.SMART_MONEY_FLUSH_MS ?? 800);
const POLL_MS = Number(process.env.SMART_MONEY_TICK_MS ?? 3_000);

interface SmState {
  lastBlock?: string;
}

async function loadState(): Promise<SmState> {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8")) as SmState;
  } catch {
    return {};
  }
}

async function saveState(s: SmState): Promise<void> {
  await writeJsonAtomic(STATE_PATH, s);
}

/** RB-chain on-chain watcher: correlates Transfer×Swap → shared engine. */
class RbBuyWatcher {
  tracked = new Set<string>();
  labels = new Map<string, string>();
  tiers = new Map<string, string | undefined>();
  private poolCache = new Map<string, PoolPair>();

  async reloadWallets(): Promise<boolean> {
    const wallets = (await loadActiveTrackedWallets()).filter(
      (w) => walletChain(w) === "robinhood",
    );
    const next = new Set(wallets.map((w) => w.address.toLowerCase()));
    this.labels = new Map(wallets.map((w) => [w.address.toLowerCase(), w.label]));
    this.tiers = new Map(wallets.map((w) => [w.address.toLowerCase(), w.tier]));
    const changed =
      next.size !== this.tracked.size ||
      [...next].some((a) => !this.tracked.has(a));
    this.tracked = next;
    return changed;
  }

  /** Resolve poolId→pair, caching; misses do one targeted Initialize getLogs. */
  private async resolvePool(poolId: string): Promise<PoolPair | undefined> {
    const cached = this.poolCache.get(poolId);
    if (cached) return cached;
    try {
      const logs = (await getLogsClient().request({
        method: "eth_getLogs",
        params: [
          {
            address: RB_V4_POOL_MANAGER,
            topics: [V4_INITIALIZE_TOPIC0, poolId as `0x${string}`],
            fromBlock: "0x0",
            toBlock: "latest",
          },
        ],
      })) as Array<{
        address: Address;
        topics: `0x${string}`[];
        data: `0x${string}`;
        blockNumber: `0x${string}`;
        transactionHash: `0x${string}`;
      }>;
      for (const raw of logs) {
        const p = decodeInitializePair({
          address: raw.address,
          topics: raw.topics,
          data: raw.data,
          blockNumber: BigInt(raw.blockNumber),
          transactionHash: raw.transactionHash,
        });
        if (p) {
          const pair = { currency0: p.currency0, currency1: p.currency1 };
          this.poolCache.set(p.poolId, pair);
          if (p.poolId === poolId) return pair;
        }
      }
    } catch (err) {
      console.error("smart-money: pool resolve failed:", (err as Error).message);
    }
    return this.poolCache.get(poolId);
  }

  /** Feed a batch of decoded transfers+swaps through the correlator + notify. */
  async process(transfers: TransferHit[], swaps: SwapHit[]): Promise<void> {
    if (!transfers.length) return;
    // Resolve pools only for swaps sharing a tx with a tracked-wallet transfer.
    const txWithTransfer = new Set(
      transfers
        .filter((t) => this.tracked.has(t.to.toLowerCase()))
        .map((t) => t.txHash),
    );
    const relevantSwaps = swaps.filter((s) => txWithTransfer.has(s.txHash));
    const pairMap = new Map<string, PoolPair>();
    for (const s of relevantSwaps) {
      const pair = await this.resolvePool(s.poolId);
      if (pair) pairMap.set(s.poolId, pair);
    }
    const buys = detectBuys(transfers, relevantSwaps, pairMap, this.tracked);
    for (const buy of buys) await this.handleBuy(buy);
  }

  /** Build a chain-agnostic buy and hand it to the shared engine. */
  private async handleBuy(buy: DetectedBuy): Promise<void> {
    const symbol = (await getErc20Symbol(buy.token as Address)) ?? "?";
    const label = this.labels.get(buy.wallet.toLowerCase()) ?? "wallet";
    // USD only known when the quote leg is a stablecoin; else leave undefined.
    const quoteMeta = Object.values(QUOTE_ASSETS).find((q) => q.symbol === buy.quoteSymbol);
    const usd =
      quoteMeta && STABLE_QUOTES.has(quoteMeta.symbol) ? buy.quoteAmount : undefined;
    const sm: SmartMoneyBuy = {
      chain: "robinhood",
      wallet: buy.wallet,
      walletLabel: label,
      token: buy.token,
      symbol,
      usd,
      txHash: buy.txHash,
      ts: Date.now(),
      source: "rpc",
      tier: this.tiers.get(buy.wallet.toLowerCase()),
    };
    await smartMoneyEngine.handleBuy(sm);
  }
}

// --- poll mode -------------------------------------------------------------

async function pollLoop(engine: RbBuyWatcher): Promise<void> {
  const client = getLogsClient();
  const state = await loadState();
  let cursor = state.lastBlock ? BigInt(state.lastBlock) : undefined;

  while (true) {
    try {
      await engine.reloadWallets();
      const latest = await client.getBlockNumber();
      if (cursor === undefined) cursor = latest; // first run: start live, no backfill
      if (latest > cursor && engine.tracked.size > 0) {
        const from = cursor + 1n;
        const walletTopics = [...engine.tracked].map((a) => addressTopic(a));
        const [transferLogs, swapLogs] = await Promise.all([
          fetchLogsChunked(client, {
            // address omitted → any token contract
            topics: [TRANSFER_TOPIC0, null, walletTopics],
            fromBlock: from,
            toBlock: latest,
            chunkSize: 5_000n,
          }),
          fetchLogsChunked(client, {
            address: RB_V4_POOL_MANAGER,
            topics: [V4_SWAP_TOPIC0],
            fromBlock: from,
            toBlock: latest,
            chunkSize: 5_000n,
          }),
        ]);
        const transfers = transferLogs
          .map(decodeTransfer)
          .filter((t): t is TransferHit => !!t);
        const swaps = swapLogs.map(decodeSwap).filter((s): s is SwapHit => !!s);
        await engine.process(transfers, swaps);
      }
      cursor = latest;
      await saveState({ lastBlock: cursor.toString() });
    } catch (err) {
      console.error("smart-money poll error:", (err as Error).message);
    }
    await sleep(POLL_MS);
  }
}

// --- push mode (wss) -------------------------------------------------------

function toRawLog(log: Log): RawLog {
  return {
    address: log.address,
    topics: log.topics as `0x${string}`[],
    data: log.data,
    blockNumber: log.blockNumber ?? 0n,
    transactionHash: log.transactionHash ?? ("0x" as `0x${string}`),
    ...({ logIndex: log.logIndex ?? 0 } as object),
  } as RawLog;
}

async function pushLoop(engine: RbBuyWatcher, wss: string): Promise<void> {
  const client = createPublicClient({
    transport: webSocket(wss, { reconnect: true, retryCount: 10 }),
  });

  // txHash → buffered legs, flushed after a short window to pair the streams.
  const buffer = new Map<
    string,
    { transfers: TransferHit[]; swaps: SwapHit[]; timer: NodeJS.Timeout }
  >();

  const scheduleFlush = (txHash: string) => {
    const entry = buffer.get(txHash);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      buffer.delete(txHash);
      void engine.process(entry.transfers, entry.swaps);
    }, FLUSH_MS);
  };

  const bufFor = (txHash: string) => {
    let e = buffer.get(txHash);
    if (!e) {
      e = { transfers: [], swaps: [], timer: setTimeout(() => {}, 0) };
      buffer.set(txHash, e);
    }
    return e;
  };

  await engine.reloadWallets();

  // Swap stream: every v4 swap on the singleton PoolManager. A swap is only
  // acted on if its tx also carries a tracked-wallet transfer (enforced in
  // engine.process); until then it just sits in the buffer and expires.
  client.watchEvent({
    address: RB_V4_POOL_MANAGER,
    event: V4_SWAP_EVENT,
    poll: false,
    onLogs: (logs) => {
      for (const log of logs) {
        const s = decodeSwap(toRawLog(log as Log));
        if (!s) continue;
        bufFor(s.txHash).swaps.push(s);
        scheduleFlush(s.txHash);
      }
    },
    onError: (err) => console.error("smart-money swap stream:", err.message),
  });

  let unwatchTransfers: (() => void) | undefined;
  const subscribeTransfers = () => {
    if (!engine.tracked.size) return undefined;
    return client.watchEvent({
      event: TRANSFER_EVENT,
      args: { to: [...engine.tracked] as Address[] },
      poll: false,
      onLogs: (logs) => {
        for (const log of logs) {
          const t = decodeTransfer(toRawLog(log as Log));
          if (!t) continue;
          bufFor(t.txHash).transfers.push(t);
          scheduleFlush(t.txHash);
        }
      },
      onError: (err) =>
        console.error("smart-money transfer stream:", err.message),
    });
  };
  unwatchTransfers = subscribeTransfers();

  console.log(`[smart-money] wss push mode on ${engine.tracked.size} wallets`);

  // Re-read the book; resubscribe the transfer stream if the wallet set moved.
  while (true) {
    await sleep(RELOAD_MS);
    const changed = await engine.reloadWallets();
    if (changed) {
      unwatchTransfers?.();
      unwatchTransfers = subscribeTransfers();
      console.log(
        `[smart-money] wallet set changed → resubscribed (${engine.tracked.size})`,
      );
    }
  }
}

/** Start the watcher. No-op (idle) until wallets are added to the book. */
export async function startSmartMoneyWatcher(): Promise<void> {
  if (process.env.SMART_MONEY === "0") return;
  const engine = new RbBuyWatcher();
  await engine.reloadWallets();
  const wss = process.env.ROBINHOOD_WSS;
  if (wss) {
    await pushLoop(engine, wss);
  } else {
    console.log(
      `[smart-money] poll mode @ ${POLL_MS}ms (set ROBINHOOD_WSS for sub-second push)`,
    );
    await pollLoop(engine);
  }
}
