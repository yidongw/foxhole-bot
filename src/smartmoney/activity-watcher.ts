import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "../lib/atomic-json.js";
import { sleep } from "../lib/utils.js";
import {
  loadTrackedWallets,
  walletChain,
  type TrackedWallet,
} from "../chains/robinhood/smart-money.js";
import { GmgnError, gmgnWalletActivity } from "./gmgn.js";
import { smartMoneyEngine, type SmartMoneyBuy } from "./engine.js";

/**
 * Live wallet tracking for non-RB chains (bsc/sol/base/eth) via GMGN
 * `portfolio activity` polling — reuses the existing GMGN key, no self-compute.
 * RB chain is handled by the sub-second on-chain wss watcher instead.
 *
 * Latency = poll interval (fine for these chains). Each wallet's last-seen tx
 * timestamp is persisted so restarts don't re-alert; first sight of a wallet
 * starts "now" to avoid backfilling its whole history.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(__dirname, "../../data/smart-money-activity-state.json");

const POLL_MS = Number(process.env.SMART_MONEY_POLL_MS ?? 15_000);
const PER_CALL_DELAY_MS = Number(process.env.SMART_MONEY_GMGN_DELAY_MS ?? 1_200);

interface ActivityState {
  lastTs: Record<string, number>; // `${chain}:${wallet}` -> last handled tx unix ts
}

async function loadState(): Promise<ActivityState> {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8")) as ActivityState;
  } catch {
    return { lastTs: {} };
  }
}

/** Chains other than robinhood that have at least one tracked wallet. */
function nonRbWalletsByChain(wallets: TrackedWallet[]): Map<string, TrackedWallet[]> {
  const byChain = new Map<string, TrackedWallet[]>();
  for (const w of wallets) {
    const chain = walletChain(w);
    if (chain === "robinhood") continue;
    (byChain.get(chain) ?? byChain.set(chain, []).get(chain)!).push(w);
  }
  return byChain;
}

export async function startActivityWatcher(): Promise<void> {
  if (process.env.SMART_MONEY === "0") return;
  const state = await loadState();

  while (true) {
    try {
      const wallets = await loadTrackedWallets();
      const byChain = nonRbWalletsByChain(wallets);
      if (byChain.size === 0) {
        await sleep(POLL_MS);
        continue;
      }

      for (const [chain, list] of byChain) {
        for (const w of list) {
          const key = `${chain}:${w.address.toLowerCase()}`;
          try {
            const acts = await gmgnWalletActivity(chain, w.address, { limit: 20 });
            const since = state.lastTs[key] ?? 0;
            let maxTs = since;
            for (const a of acts) {
              if (a.event_type !== "buy") continue;
              if (a.timestamp <= since) continue;
              maxTs = Math.max(maxTs, a.timestamp);
              // On the very first pass for an unseen wallet, don't replay history.
              if (since === 0) continue;
              const buy: SmartMoneyBuy = {
                chain,
                wallet: w.address,
                walletLabel: w.label,
                token: a.token.address,
                symbol: a.token.symbol ?? "?",
                usd: a.cost_usd ? Number(a.cost_usd) : undefined,
                txHash: a.tx_hash,
                ts: a.timestamp * 1000,
                source: "gmgn",
              };
              await smartMoneyEngine.handleBuy(buy);
            }
            if (maxTs > (state.lastTs[key] ?? 0)) state.lastTs[key] = maxTs;
          } catch (err) {
            const rl = err instanceof GmgnError && err.rateLimited;
            if (rl) await sleep(5_000);
            else console.error(`smart-money activity ${key}:`, (err as Error).message);
          }
          await sleep(PER_CALL_DELAY_MS);
        }
      }
      await writeJsonAtomic(STATE_PATH, state);
    } catch (err) {
      console.error("smart-money activity loop error:", (err as Error).message);
    }
    await sleep(POLL_MS);
  }
}
