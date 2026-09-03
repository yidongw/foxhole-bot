import { GmgnError, gmgnTokenTraders, type GmgnTrader } from "./gmgn.js";

/**
 * Multi-source "profitable wallets for a token" layer. GMGN is primary; Nansen
 * / Birdeye / Codex are dormant failover providers that activate when their API
 * key is present. This removes the GMGN single-point-of-failure: if GMGN is
 * rate-limited or down, the next available provider is tried. We never compute
 * PnL ourselves — every provider returns ready-made ranked wallets.
 */

export interface ProfitWallet {
  address: string;
  realizedUsd?: number;
  unrealizedUsd?: number;
  profitUsd?: number;
  buyTx?: number;
  sellTx?: number;
  suspicious?: boolean;
  isContract?: boolean;
  tags: string[];
  source: string;
}

interface ProfitProvider {
  name: string;
  available(): boolean;
  topTraders(chain: string, token: string, limit: number): Promise<ProfitWallet[]>;
}

const gmgnProvider: ProfitProvider = {
  name: "gmgn",
  available: () => true, // relies on gmgn-cli global config / env key
  async topTraders(chain, token, limit) {
    const rows = await gmgnTokenTraders(chain, token, { limit, orderBy: "profit" });
    return rows.map((r: GmgnTrader) => ({
      address: r.address,
      realizedUsd: Number(r.realized_profit ?? 0),
      unrealizedUsd: Number(r.unrealized_profit ?? 0),
      profitUsd: Number(r.profit ?? 0),
      buyTx: Number(r.buy_tx_count_cur ?? 0),
      sellTx: Number(r.sell_tx_count_cur ?? 0),
      suspicious: Boolean(r.is_suspicious),
      isContract: r.addr_type === 2 || Boolean(r.exchange),
      tags: (r.tags ?? []) as string[],
      source: "gmgn",
    }));
  },
};

const nansenProvider: ProfitProvider = {
  name: "nansen",
  available: () => Boolean(process.env.NANSEN_API_KEY),
  async topTraders(chain, token, limit) {
    const res = await fetch("https://api.nansen.ai/api/v1/tgm/pnl-leaderboard", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apiKey: process.env.NANSEN_API_KEY as string,
      },
      body: JSON.stringify({ chain, token_address: token, pagination: { page: 1, per_page: limit } }),
    });
    if (!res.ok) throw new Error(`nansen HTTP ${res.status}`);
    const j = (await res.json()) as { data?: Array<Record<string, unknown>> };
    return (j.data ?? []).map((r) => ({
      address: String(r.address ?? r.wallet ?? ""),
      realizedUsd: Number(r.realized_profit_usd ?? r.realized_pnl ?? 0),
      unrealizedUsd: Number(r.unrealized_profit_usd ?? r.unrealized_pnl ?? 0),
      profitUsd: Number(r.total_pnl_usd ?? r.pnl ?? 0),
      tags: (r.labels as string[]) ?? [],
      source: "nansen",
    }));
  },
};

const birdeyeProvider: ProfitProvider = {
  name: "birdeye",
  available: () => Boolean(process.env.BIRDEYE_API_KEY),
  async topTraders(chain, token, limit) {
    const url = `https://public-api.birdeye.so/defi/v2/tokens/top_traders?address=${token}&sort_by=total_pnl&sort_type=desc&limit=${Math.min(limit, 10)}`;
    const res = await fetch(url, {
      headers: {
        "x-api-key": process.env.BIRDEYE_API_KEY as string,
        "x-chain": chain,
      },
    });
    if (!res.ok) throw new Error(`birdeye HTTP ${res.status}`);
    const j = (await res.json()) as { data?: { items?: Array<Record<string, unknown>> } };
    return (j.data?.items ?? []).map((r) => ({
      address: String(r.owner ?? r.address ?? ""),
      realizedUsd: Number(r.realizedPnl ?? 0),
      unrealizedUsd: Number(r.unrealizedPnl ?? 0),
      profitUsd: Number(r.totalPnl ?? 0),
      tags: [],
      source: "birdeye",
    }));
  },
};

// Codex.io is GraphQL and needs bespoke query wiring; registered but inert
// until implemented, so failover simply skips it.
const codexProvider: ProfitProvider = {
  name: "codex",
  available: () => false,
  async topTraders() {
    throw new Error("codex provider not implemented");
  },
};

const PROVIDERS: ProfitProvider[] = [
  gmgnProvider,
  nansenProvider,
  birdeyeProvider,
  codexProvider,
];

/** Try each available provider in order; return the first that succeeds. */
export async function topTraders(
  chain: string,
  token: string,
  limit = 100,
): Promise<{ wallets: ProfitWallet[]; source: string }> {
  const errors: string[] = [];
  for (const p of PROVIDERS) {
    if (!p.available()) continue;
    try {
      const wallets = await p.topTraders(chain, token, limit);
      if (wallets.length) return { wallets, source: p.name };
      errors.push(`${p.name}: empty`);
    } catch (err) {
      const rl = err instanceof GmgnError && err.rateLimited ? " (rate-limited)" : "";
      errors.push(`${p.name}: ${(err as Error).message}${rl}`);
    }
  }
  throw new Error(`all profit providers failed: ${errors.join(" | ")}`);
}

/** Keep only wallets worth tracking: real profit, took profit, not a bot/MM. */
export function qualifyWallet(w: ProfitWallet, minRealizedUsd = 1000): boolean {
  if (w.suspicious || w.isContract) return false;
  if ((w.realizedUsd ?? 0) < minRealizedUsd) return false;
  if ((w.sellTx ?? 1) < 1) return false;
  if ((w.buyTx ?? 0) + (w.sellTx ?? 0) > 3000) return false; // market-maker/bot
  const bad = new Set([
    "dev",
    "dex_bot",
    "bundler",
    "rat_trader",
    "sandwich_bot",
    "mev_bot",
    "wash_trader",
  ]);
  if (w.tags.some((t) => bad.has(t))) return false;
  return true;
}

export interface WinnerCandidate {
  address: string;
  tokens: string[];
  realizedUsd: number;
  tags: string[];
}

/** Aggregate qualifying winners across several tokens → cross-token ranking. */
export async function findWinners(
  chain: string,
  tokens: { address: string; label?: string }[],
  opts: { minRealizedUsd?: number; delayMs?: number } = {},
): Promise<{ candidates: WinnerCandidate[]; perToken: Record<string, string> }> {
  const agg = new Map<string, WinnerCandidate>();
  const perToken: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const name = t.label ?? t.address.slice(0, 8);
    try {
      const { wallets, source } = await topTraders(chain, t.address);
      let kept = 0;
      for (const w of wallets) {
        if (!qualifyWallet(w, opts.minRealizedUsd)) continue;
        const a = w.address.toLowerCase();
        const c = agg.get(a) ?? { address: w.address, tokens: [], realizedUsd: 0, tags: [] };
        c.tokens.push(name);
        c.realizedUsd += w.realizedUsd ?? 0;
        c.tags = [...new Set([...c.tags, ...w.tags])];
        agg.set(a, c);
        kept++;
      }
      perToken[name] = `${wallets.length} traders, ${kept} pass (${source})`;
    } catch (err) {
      perToken[name] = `ERR ${(err as Error).message.slice(0, 80)}`;
    }
    if (opts.delayMs && i < tokens.length - 1) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
  }
  const candidates = [...agg.values()].sort(
    (a, b) => b.tokens.length - a.tokens.length || b.realizedUsd - a.realizedUsd,
  );
  return { candidates, perToken };
}
