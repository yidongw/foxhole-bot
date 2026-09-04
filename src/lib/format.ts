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
