import WebSocket from "ws";

import { sleep } from "../lib/utils.js";
import {
  loadTrackedWallets,
  walletChain,
  type TrackedWallet,
} from "../chains/robinhood/smart-money.js";
import { smartMoneyEngine, type SmartMoneyBuy } from "./engine.js";

/**
 * Cielo Finance per-wallet websocket adapter — sub-second push for the chains
 * Cielo indexes (bsc/solana/base/eth). Dormant until CIELO_API_KEY is set.
 * RB chain is NOT covered by Cielo and stays on its own on-chain wss watcher.
 *
 * When enabled, Cielo takes over the covered chains and the GMGN activity
 * poller skips them (see activity-watcher.ts) so buys aren't double-counted.
 *
 * NOTE: Cielo's exact swap-message field names are parsed defensively below —
 * verify `parseCieloBuy` against a live message once a key is in hand; the
 * shape is best-effort from the public docs.
 */

const WS_URL = "wss://feed-api.cielo.finance/api/v1/ws";
const RELOAD_MS = 30_000;

/** Our chain ids that Cielo can serve (override with CIELO_CHAINS). */
export function cieloCoveredChains(): Set<string> {
  const raw = process.env.CIELO_CHAINS ?? "bsc,sol,solana,base,eth,ethereum";
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export function cieloEnabled(): boolean {
  return Boolean(process.env.CIELO_API_KEY) && process.env.SMART_MONEY !== "0";
}

/** Normalise a Cielo chain string to our internal id (engine handles aliases). */
function normChain(c: unknown): string {
  const s = String(c ?? "").toLowerCase();
  if (s === "solana") return "sol";
  if (s === "ethereum") return "eth";
  return s || "unknown";
}

/** Best-effort: turn a Cielo feed message into a buy, or null if not one. */
export function parseCieloBuy(
  msg: Record<string, unknown>,
  labelFor: (wallet: string) => string,
): SmartMoneyBuy | null {
  // Cielo wraps feed items under {type:"feed"|"tx", data:{...}} in some modes.
  const d = ((msg.data as Record<string, unknown>) ?? msg) as Record<string, unknown>;
  const txType = String(d.tx_type ?? d.txType ?? d.type ?? "").toLowerCase();
  if (txType && txType !== "swap") return null;

  const wallet = String(d.wallet ?? d.wallet_address ?? d.from ?? "");
  if (!wallet) return null;

  // token0 = spent (base), token1 = received (bought) in Cielo's swap schema.
  const boughtAddr = d.token1_address ?? d.token1 ?? d.to_token_address;
  const boughtSym = d.token1_symbol ?? d.to_token_symbol;
  if (!boughtAddr) return null;

  const usdRaw =
    d.token1_amount_usd ?? d.token0_amount_usd ?? d.amount_usd ?? d.value_usd;
  const usd = usdRaw != null ? Number(usdRaw) : undefined;

  const ts = Number(d.timestamp ?? d.block_time ?? Date.now() / 1000) * 1000;

  return {
    chain: normChain(d.chain ?? d.network),
    wallet,
    walletLabel: labelFor(wallet),
    token: String(boughtAddr),
    symbol: String(boughtSym ?? "?"),
    usd: Number.isFinite(usd) ? usd : undefined,
    txHash: String(d.tx_hash ?? d.hash ?? d.txHash ?? ""),
    ts: Number.isFinite(ts) ? ts : Date.now(),
    source: "cielo",
  };
}

export async function startCieloWatcher(): Promise<void> {
  if (!cieloEnabled()) return;
  const covered = cieloCoveredChains();
  let labels = new Map<string, string>();
  const labelFor = (w: string) => labels.get(w.toLowerCase()) ?? "wallet";

  const cieloWallets = async (): Promise<TrackedWallet[]> => {
    const all = await loadTrackedWallets();
    const list = all.filter((w) => covered.has(walletChain(w)));
    labels = new Map(list.map((w) => [w.address.toLowerCase(), w.label]));
    return list;
  };

  let backoff = 1_000;
  // Reconnect loop.
  while (true) {
    let ws: WebSocket | undefined;
    try {
      const wallets = await cieloWallets();
      if (!wallets.length) {
        await sleep(RELOAD_MS);
        continue;
      }
      ws = new WebSocket(WS_URL, {
        headers: { "X-API-KEY": process.env.CIELO_API_KEY as string },
      });
      const socket = ws;

      let subscribed = new Set<string>();
      const subscribe = (list: TrackedWallet[]) => {
        for (const w of list) {
          const a = w.address.toLowerCase();
          if (subscribed.has(a)) continue;
          socket.send(JSON.stringify({ type: "subscribe_wallet", wallet: w.address }));
          subscribed.add(a);
        }
      };

      await new Promise<void>((resolve, reject) => {
        socket.on("open", () => {
          backoff = 1_000;
          subscribe(wallets);
          console.log(`[smart-money] cielo wss connected (${wallets.length} wallets)`);
        });
        socket.on("message", (raw: WebSocket.RawData) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }
          const buy = parseCieloBuy(msg, labelFor);
          if (buy && covered.has(buy.chain)) void smartMoneyEngine.handleBuy(buy);
        });
        socket.on("close", () => resolve());
        socket.on("error", (err: Error) => {
          console.error("[smart-money] cielo wss error:", err.message);
          reject(err);
        });

        // Periodically pick up newly-added wallets without reconnecting.
        const reloadTimer = setInterval(() => {
          void cieloWallets().then((list) => subscribe(list)).catch(() => {});
        }, RELOAD_MS);
        socket.on("close", () => clearInterval(reloadTimer));
      });
    } catch (err) {
      console.error("[smart-money] cielo loop:", (err as Error).message);
    } finally {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }
}
