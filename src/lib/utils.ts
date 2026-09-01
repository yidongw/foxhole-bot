import { STOCK_QUOTES, STABLE_QUOTES } from "../long/constants.js";

export function isStockQuote(symbol: string | undefined): boolean {
  if (!symbol) return false;
  if (STABLE_QUOTES.has(symbol)) return false;
  if (STOCK_QUOTES.has(symbol)) return true;
  return symbol === symbol.toUpperCase() && symbol.length <= 6;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatUsd(n: number | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function formatPct(n: number | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}
