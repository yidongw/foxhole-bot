import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { kvGet, kvSet } from "../lib/db.js";

/**
 * Per-chain and per-wallet smart-money filter config, hot-reloaded from
 * data/smart-money-config.json (edited via the CLI or dashboard). Resolution
 * order: built-in defaults ← global ← per-chain ← per-wallet. Env vars provide
 * the initial global defaults so existing setups keep working.
 *
 * Two gates per resolved filter:
 *   - alertMinUsd  : below this, a buy is NOT alerted (loose gate).
 *   - AI trigger   : aiConvictionN distinct wallets within aiWindowMin AND each
 *                    buy ≥ aiMinUsd → produce a trade signal + wake AI.
 *                    soloTrigger=true lets a single wallet trigger on its own.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KV_KEY = "smartmoney:config";
/** Legacy JSON import source (pre-SQLite); overridable for tests. */
function legacyConfigPath(): string {
  return process.env.SMART_MONEY_CONFIG_PATH ?? path.resolve(__dirname, "../../data/smart-money-config.json");
}

export interface SmartMoneyFilter {
  alertMinUsd: number;
  aiConvictionN: number;
  aiWindowMin: number;
  aiMinUsd: number;
  soloTrigger: boolean;
  /** Suppress repeat alerts for the same (wallet, token) within N minutes. */
  alertCooldownMin: number;
  /** AI-trigger anti-chase gates (checked once per escalation, off the hot path):
   *  - only wake AI if token liquidity ≥ this (thin pools = un-copyable dumps);
   *  - skip if the token already ran > these %  (late / post-hoc, we'd buy the top).
   *  0 = gate off. */
  aiMinLiquidityUsd: number;
  aiMaxPump1hPct: number;
  aiMaxPump24hPct: number;
}

export interface SmartMoneyConfig {
  defaults: Partial<SmartMoneyFilter>;
  chains: Record<string, Partial<SmartMoneyFilter>>;
  wallets: Record<string, Partial<SmartMoneyFilter>>;
}

const num = (k: string, d: number) => Number(process.env[k] ?? d);

/** Global defaults, seeded from env so prior config still applies. */
function envDefaults(): SmartMoneyFilter {
  return {
    alertMinUsd: num("SMART_MONEY_MIN_USD", 0),
    aiConvictionN: num("SMART_MONEY_CONVICTION_N", 2),
    aiWindowMin: num("SMART_MONEY_WINDOW_MIN", 60),
    aiMinUsd: num("SMART_MONEY_AI_MIN_USD", 0),
    soloTrigger: false,
    alertCooldownMin: num("SMART_MONEY_ALERT_COOLDOWN_MIN", 0),
    aiMinLiquidityUsd: num("SMART_MONEY_AI_MIN_LIQ_USD", 0),
    aiMaxPump1hPct: num("SMART_MONEY_AI_MAX_PUMP_1H", 0),
    aiMaxPump24hPct: num("SMART_MONEY_AI_MAX_PUMP_24H", 0),
  };
}

/**
 * Built-in per-chain defaults. RB is the home chain (keep everything); the
 * GMGN smart_degen wallets on bsc/sol are hyper-active, so raise the bar to
 * cut noise and only wake AI on meaningful size.
 */
// Anti-chase AI-trigger gates shared by all chains (calibrated on the 事后
// signals: thin $5–14k pools that ran pre-trigger then dumped −50~−82%). Only
// wake AI on a liquid token that hasn't already blown off.
const ANTI_CHASE = { aiMinLiquidityUsd: 20_000, aiMaxPump1hPct: 100, aiMaxPump24hPct: 300 };

const CHAIN_DEFAULTS: Record<string, Partial<SmartMoneyFilter>> = {
  // RB is the home chain (keep all sizes) but a wallet re-buying the same token
  // (e.g. the HOOD accumulator) spams — so cool down repeat same-token alerts.
  // RB liq floor lowered $20k→$12k: on RB the low-liq launches ARE the alpha —
  // 2026-09-05 the $20k floor blocked Viagra ($16k liq → +924%) and OZEMPIC
  // ($9k → +1326%, still sub-floor) while every token that PASSED the floor
  // (BA/SCHRODINGER/NAGA, $22–208k) went flat. These were liq-blocked only, NOT
  // pump-blocked = genuine early smart-money entries. Pump caps stay as the real
  // anti-chase; sub-$12k stays out (rug-dense: MeiMei/CIRCLEJERK −43~−64%).
  robinhood: { alertMinUsd: 0, aiMinUsd: 0, alertCooldownMin: 30, ...ANTI_CHASE, aiMinLiquidityUsd: 12_000 },
  // Calibrated on live data: BSC smart-money buys are small (median ~$48, max
  // ~$712 over 3h), so the old $1000/$3000 gates blocked 100% of buys.
  bsc: { alertMinUsd: 300, aiMinUsd: 500, ...ANTI_CHASE },
  sol: { alertMinUsd: 150, aiMinUsd: 400, ...ANTI_CHASE },
  solana: { alertMinUsd: 150, aiMinUsd: 400, ...ANTI_CHASE },
  base: { alertMinUsd: 200, aiMinUsd: 500, ...ANTI_CHASE },
  eth: { alertMinUsd: 200, aiMinUsd: 500, ...ANTI_CHASE },
  ethereum: { alertMinUsd: 200, aiMinUsd: 500, ...ANTI_CHASE },
};

let cache: { at: number; config: SmartMoneyConfig } | undefined;
const TTL_MS = 10_000;

export async function loadConfig(): Promise<SmartMoneyConfig> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.config;
  let file: Partial<SmartMoneyConfig> = {};
  try {
    const raw = kvGet(KV_KEY);
    if (raw) {
      file = JSON.parse(raw) as SmartMoneyConfig;
    } else {
      // One-time import of the pre-SQLite JSON, then persist to kv.
      const legacy = legacyConfigPath();
      if (existsSync(legacy)) {
        file = JSON.parse(readFileSync(legacy, "utf8")) as SmartMoneyConfig;
        kvSet(KV_KEY, JSON.stringify(file));
      }
    }
  } catch {
    // no config yet → built-in defaults only
  }
  const config: SmartMoneyConfig = {
    defaults: file.defaults ?? {},
    chains: file.chains ?? {},
    wallets: file.wallets ?? {},
  };
  cache = { at: Date.now(), config };
  return config;
}

export async function saveConfig(config: SmartMoneyConfig): Promise<void> {
  kvSet(KV_KEY, JSON.stringify(config));
  cache = { at: Date.now(), config };
}

/** Merge built-in defaults ← env ← file.defaults ← chain ← wallet. */
export function resolveFilterSync(
  config: SmartMoneyConfig,
  chain: string,
  wallet: string,
): SmartMoneyFilter {
  const c = chain.toLowerCase();
  const w = wallet.toLowerCase();
  return {
    ...envDefaults(),
    ...(CHAIN_DEFAULTS[c] ?? {}),
    ...config.defaults,
    ...(config.chains[c] ?? {}),
    ...(config.wallets[w] ?? {}),
  };
}

export async function resolveFilter(
  chain: string,
  wallet: string,
): Promise<SmartMoneyFilter> {
  return resolveFilterSync(await loadConfig(), chain, wallet);
}

/** Effective per-chain filter (no wallet override) — for the dashboard. */
export async function chainFilter(chain: string): Promise<SmartMoneyFilter> {
  return resolveFilter(chain, "0x0");
}
