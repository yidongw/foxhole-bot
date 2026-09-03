import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "../lib/atomic-json.js";
import { sleep } from "../lib/utils.js";
import { loadActiveTrackedWallets, walletChain } from "../chains/robinhood/smart-money.js";
import { loadConfig, resolveFilterSync, type SmartMoneyFilter } from "./config.js";
import { readSmLog } from "./log.js";

/**
 * Writes web/data/smart-money.json for the dashboard: every tracked wallet with
 * its resolved (chain+wallet) filter, the per-chain AI-trigger conditions, and
 * recent alert/trigger activity — so the whole smart-money layer is managed and
 * inspected from one page.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATHS = [
  path.resolve(__dirname, "../../web/data/smart-money.json"),
  path.resolve(__dirname, "../../data/smart-money-dashboard.json"),
];

const DASH_INTERVAL_MS = Number(process.env.SMART_MONEY_DASH_MS ?? 20_000);

export interface DashboardWallet {
  address: string;
  label: string;
  chain: string;
  tier?: string;
  realizedUsd?: number;
  filter: SmartMoneyFilter;
}

export async function buildDashboard(): Promise<{
  generatedAt: string;
  wallets: DashboardWallet[];
  chainConditions: Record<string, SmartMoneyFilter>;
  recent: Awaited<ReturnType<typeof readSmLog>>;
}> {
  const config = await loadConfig();
  const wallets = await loadActiveTrackedWallets();
  const rows: DashboardWallet[] = wallets.map((w) => {
    const chain = walletChain(w);
    return {
      address: w.address,
      label: w.label,
      chain,
      tier: w.tier,
      realizedUsd: w.realizedUsd,
      filter: resolveFilterSync(config, chain, w.address),
    };
  });

  const chains = [...new Set(rows.map((r) => r.chain))];
  const chainConditions: Record<string, SmartMoneyFilter> = {};
  for (const c of chains) chainConditions[c] = resolveFilterSync(config, c, "0x0");

  // Last 24h of alert/trigger activity, newest first, capped.
  const recent = (await readSmLog(Date.now() - 24 * 3_600_000))
    .filter((r) => r.kind !== "skipped")
    .slice(-200)
    .reverse();

  return { generatedAt: new Date().toISOString(), wallets: rows, chainConditions, recent };
}

async function writeOnce(): Promise<void> {
  const payload = await buildDashboard();
  for (const p of OUT_PATHS) await writeJsonAtomic(p, payload);
}

/** Periodically refresh the dashboard JSON (idempotent, cheap). */
export async function startDashboardWriter(): Promise<void> {
  while (true) {
    try {
      await writeOnce();
    } catch (err) {
      console.error("smart-money dashboard write failed:", (err as Error).message);
    }
    await sleep(DASH_INTERVAL_MS);
  }
}
