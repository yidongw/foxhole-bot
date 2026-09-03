import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "../lib/atomic-json.js";

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
const CONFIG_PATH = path.resolve(__dirname, "../../data/smart-money-config.json");

export interface SmartMoneyFilter {
  alertMinUsd: number;
  aiConvictionN: number;
  aiWindowMin: number;
  aiMinUsd: number;
  soloTrigger: boolean;
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
  };
}

/**
 * Built-in per-chain defaults. RB is the home chain (keep everything); the
 * GMGN smart_degen wallets on bsc/sol are hyper-active, so raise the bar to
 * cut noise and only wake AI on meaningful size.
 */
const CHAIN_DEFAULTS: Record<string, Partial<SmartMoneyFilter>> = {
  robinhood: { alertMinUsd: 0, aiMinUsd: 0 },
  bsc: { alertMinUsd: 1000, aiMinUsd: 3000 },
  sol: { alertMinUsd: 500, aiMinUsd: 2000 },
  solana: { alertMinUsd: 500, aiMinUsd: 2000 },
  base: { alertMinUsd: 500, aiMinUsd: 2000 },
  eth: { alertMinUsd: 500, aiMinUsd: 2000 },
  ethereum: { alertMinUsd: 500, aiMinUsd: 2000 },
};

let cache: { at: number; config: SmartMoneyConfig } | undefined;
const TTL_MS = 10_000;

export async function loadConfig(): Promise<SmartMoneyConfig> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.config;
  let file: Partial<SmartMoneyConfig> = {};
  try {
    file = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as SmartMoneyConfig;
  } catch {
    // no file yet → built-in defaults only
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
  await writeJsonAtomic(CONFIG_PATH, config);
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
