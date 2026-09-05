import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper over the `gmgn-cli` binary (GMGN OpenAPI). The CLI reads its
 * key from ~/.config/gmgn/.env; we also forward GMGN_API_KEY if present in the
 * process env. Read-only endpoints only (token traders, wallet activity).
 *
 * The CLI prints a JSON body on success and a `[gmgn-cli] ... failed: HTTP
 * <code>` line on error (429 rate-limit, etc.) — we surface that as a throw.
 */

export class GmgnError extends Error {
  constructor(
    message: string,
    readonly rateLimited: boolean,
  ) {
    super(message);
    this.name = "GmgnError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seconds to wait out a GMGN rate-limit ban, parsed from the CLI's
 * "…(~141s remaining)…" hint; capped so we never block absurdly long. */
function banWaitMs(text: string): number {
  const m = text.match(/~(\d+)s remaining/);
  const secs = m ? Number(m[1]) : 30;
  return Math.min(Math.max(secs + 3, 5), 150) * 1000;
}

async function runOnce(args: string[]): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("gmgn-cli", args, {
      env: process.env,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    throw new GmgnError(`gmgn-cli spawn failed: ${msg}`, /429|RATE_LIMIT/.test(msg));
  }
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new GmgnError(
      `gmgn-cli non-JSON output: ${trimmed.slice(0, 200)}`,
      /429|RATE_LIMIT/.test(trimmed),
    );
  }
}

/**
 * Run gmgn-cli, waiting out a rate-limit ban and retrying. GMGN's free tier
 * shares one IP across every caller (revet / find2 / winner-finder / profit) so
 * bursts trip an IP ban; without this, callers silently fail (revet skipped 28
 * RB wallets on 2026-09-05). We back off for the ban's own reported reset window
 * (once cleared, later calls in the same run sail through), up to 2 retries.
 */
async function run(args: string[], retries = 2): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runOnce(args);
    } catch (err) {
      if (err instanceof GmgnError && err.rateLimited && attempt < retries) {
        await sleep(banWaitMs(err.message));
        continue;
      }
      throw err;
    }
  }
}

/** Unwrap {data:{...}} | {...} envelopes GMGN uses inconsistently. */
function unwrap(d: unknown): Record<string, unknown> {
  const o = d as Record<string, unknown>;
  return (o.data as Record<string, unknown>) ?? o;
}

export interface GmgnTrader {
  address: string;
  realized_profit?: number;
  profit?: number;
  unrealized_profit?: number;
  buy_tx_count_cur?: number;
  sell_tx_count_cur?: number;
  is_suspicious?: boolean;
  tags?: string[];
  addr_type?: number;
  exchange?: string;
  [k: string]: unknown;
}

/** GMGN's EVM endpoints only match lowercase addresses; base58 (SOL) is left as-is. */
function normAddr(a: string): string {
  return a.startsWith("0x") ? a.toLowerCase() : a;
}

/**
 * gmgn-cli's chain vocabulary is strict: sol/bsc/base/eth/robinhood/arc/stable.
 * Callers (review find2, monitor) use the long forms solana/ethereum, so an
 * un-normalized "solana" made gmgn-cli exit `Invalid chain: "solana"` — which
 * surfaced as `spawn failed` and silently zeroed out EVERY solana smart-money
 * find2 (coarse: all profit providers failed → 0 wallets). Map long→short here
 * so the whole gmgn layer accepts either form.
 */
function normChain(chain: string): string {
  const map: Record<string, string> = {
    solana: "sol",
    ethereum: "eth",
    ether: "eth",
  };
  return map[chain.toLowerCase()] ?? chain.toLowerCase();
}

export async function gmgnTokenTraders(
  chain: string,
  token: string,
  opts: { limit?: number; orderBy?: string } = {},
): Promise<GmgnTrader[]> {
  const d = unwrap(
    await run([
      "token",
      "traders",
      "--chain",
      normChain(chain),
      "--address",
      normAddr(token),
      "--limit",
      String(opts.limit ?? 100),
      "--order-by",
      opts.orderBy ?? "profit",
      "--direction",
      "desc",
    ]),
  );
  return (d.list as GmgnTrader[]) ?? [];
}

export interface GmgnStats {
  realized_profit: number;
  realized_profit_pnl: number; // ROI ratio (2.35 = +235%)
  total_cost: number;
  last_timestamp: number;
  pnl_stat: {
    token_num: number;
    winrate: number;
    pnl_lt_nd5_num: number; // tokens with loss < -50%
    pnl_nd5_0x_num: number; // loss -50%..0
    pnl_0x_2x_num: number; // 0..2x
    pnl_2x_5x_num: number; // 2x..5x
    pnl_gt_5x_num: number; // > 5x
    avg_holding_period: number;
  };
  tags: string[];
}

export async function gmgnPortfolioStats(
  chain: string,
  wallet: string,
  period: "7d" | "30d" = "30d",
): Promise<GmgnStats | undefined> {
  const d = unwrap(
    await run([
      "portfolio",
      "stats",
      "--chain",
      normChain(chain),
      "--wallet",
      normAddr(wallet),
      "--period",
      period,
    ]),
  );
  const pnl = (d.pnl_stat ?? {}) as Record<string, number>;
  if (d.pnl_stat === undefined) return undefined;
  const common = (d.common ?? {}) as { tags?: string[] };
  return {
    realized_profit: Number(d.realized_profit ?? 0),
    realized_profit_pnl: Number(d.realized_profit_pnl ?? 0),
    total_cost: Number(d.total_cost ?? 0),
    last_timestamp: Number(d.last_timestamp ?? 0),
    pnl_stat: {
      token_num: Number(pnl.token_num ?? 0),
      winrate: Number(pnl.winrate ?? 0),
      pnl_lt_nd5_num: Number(pnl.pnl_lt_nd5_num ?? 0),
      pnl_nd5_0x_num: Number(pnl.pnl_nd5_0x_num ?? 0),
      pnl_0x_2x_num: Number(pnl.pnl_0x_2x_num ?? 0),
      pnl_2x_5x_num: Number(pnl.pnl_2x_5x_num ?? 0),
      pnl_gt_5x_num: Number(pnl.pnl_gt_5x_num ?? 0),
      avg_holding_period: Number(pnl.avg_holding_period ?? 0),
    },
    tags: common.tags ?? [],
  };
}

export interface GmgnActivity {
  wallet: string;
  chain: string;
  tx_hash: string;
  timestamp: number;
  event_type: string; // buy | sell | ...
  token: { address: string; symbol?: string; total_supply?: string };
  token_amount?: string;
  quote_amount?: string;
  cost_usd?: string;
  price_usd?: string;
  [k: string]: unknown;
}

export async function gmgnWalletActivity(
  chain: string,
  wallet: string,
  opts: { limit?: number } = {},
): Promise<GmgnActivity[]> {
  const d = unwrap(
    await run([
      "portfolio",
      "activity",
      "--chain",
      normChain(chain),
      "--wallet",
      normAddr(wallet),
      "--limit",
      String(opts.limit ?? 20),
    ]),
  );
  return (
    (d.activities as GmgnActivity[]) ??
    (d.list as GmgnActivity[]) ??
    []
  );
}
