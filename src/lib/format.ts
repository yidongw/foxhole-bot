/** Compact USD for Discord trade logs: $840K / $12.3M / $1.2B. */
export function fmtUsdCompact(n?: number): string | undefined {
  if (n == null || !Number.isFinite(n) || n <= 0) return undefined;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

/**
 * " · FDV $12.3M" suffix for trade-log lines (spot AND perp use the same tag
 * so the two message families stay visually aligned). Empty when unknown —
 * e.g. HIP-3 stock perps with no DEX spot market.
 */
export function fdvTag(fdvUsd?: number): string {
  const s = fmtUsdCompact(fdvUsd);
  return s ? ` · FDV ${s}` : "";
}

const GMGN_CHAIN: Record<string, string> = {
  solana: "sol",
  sol: "sol",
  bsc: "bsc",
  base: "base",
  ethereum: "eth",
  eth: "eth",
};

/** Shared token link row (DexScreener/GMGN/GT/Explorer/Long) — matches the
 *  standard signal card so smart-money signals look the same as the rest. */
export function tokenLinks(chain: string, token: string, pairAddress?: string): string {
  const c = chain.toLowerCase();
  const links = [
    `[📈 DexScreener](https://dexscreener.com/${c}/${pairAddress ?? token})`,
  ];
  const g = GMGN_CHAIN[c];
  if (g) links.push(`[🔍 GMGN](https://gmgn.ai/${g}/token/${token})`);
  if (pairAddress)
    links.push(
      `[🦎 GT](https://www.geckoterminal.com/${c === "ethereum" ? "eth" : c}/pools/${pairAddress})`,
    );
  if (c === "robinhood") {
    links.push(
      `[🔗 Explorer](https://robinhoodchain.blockscout.com/token/${token})`,
      `[🏠 Long](https://app.long.xyz/tokens/${token})`,
    );
  }
  return links.join(" · ");
}
