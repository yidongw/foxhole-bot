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

/**
 * Internal chain name → gmgn.ai URL slug. gmgn indexes all of these including
 * Robinhood Chain (slug `robinhood`, added by gmgn in 2026 — web + app + API).
 */
export const GMGN_SLUG: Record<string, string> = {
  solana: "sol",
  sol: "sol",
  bsc: "bsc",
  base: "base",
  ethereum: "eth",
  eth: "eth",
  robinhood: "robinhood",
};

/**
 * Markdown gmgn.ai chart link for a trade-log / signal line so every on-chain
 * trade signal carries a one-click way to open the token on gmgn. Empty string
 * when chain/address is missing or the chain isn't on gmgn, so callers can
 * append it unconditionally (filter falsy).
 */
export function gmgnLink(chain?: string, address?: string): string {
  if (!chain || !address) return "";
  const slug = GMGN_SLUG[chain];
  return slug ? `[🔍 GMGN](https://gmgn.ai/${slug}/token/${address})` : "";
}

/**
 * Shared token link row (DexScreener/GMGN/GT/Explorer/Long) — matches the
 * standard signal card so smart-money signals look the same as the rest.
 */
export function tokenLinks(chain: string, token: string, pairAddress?: string): string {
  const c = chain.toLowerCase();
  const links = [
    `[📈 DexScreener](https://dexscreener.com/${c}/${pairAddress ?? token})`,
  ];
  const slug = GMGN_SLUG[c];
  if (slug) links.push(`[🔍 GMGN](https://gmgn.ai/${slug}/token/${token})`);
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

/** Discord dynamic-timestamp token (<t:unix:style>) from an ISO string. */
function discordTs(iso: string, style: "R" | "f" = "R"): string {
  return `<t:${Math.floor(new Date(iso).getTime() / 1000)}:${style}>`;
}

/**
 * One trade signal, source-agnostic. Every source posting into the trade-signal
 * channel (monitor, news, smart-money, and any future source) fills this and
 * renders through {@link formatSignalCard} so the cards look identical. Source
 * flavour goes in `badge` (header suffix), `extraLines` (after the links row)
 * and `statusLine` (bottom) — the skeleton stays the same.
 */
export interface SignalCardModel {
  chain: string;
  symbol?: string;
  address: string;
  primaryPair?: string;
  primaryPairAddress?: string;
  priceUsd?: number;
  liquidityUsd?: number;
  fdvUsd?: number;
  /** ISO — token launch time (发射 line). */
  launchAt?: string;
  /** ISO — first-trigger time (首次触发 line). */
  firstAt?: string;
  /** repeat-trigger count; >1 renders the 🔁 第 N 次 badge with `lastAt`. */
  repeatCount?: number;
  /** ISO — most recent trigger time (for the 🔁 repeat badge). */
  lastAt?: string;
  /** trigger tags (触发器 …), first 3 shown. */
  triggers?: string[];
  /** header suffix, e.g. "🐳 聪明钱" / "📰 新闻". */
  badge?: string;
  /** source-specific lines inserted after the links / 首次触发 block. */
  extraLines?: string[];
  /** bottom status line, e.g. "🤖 已唤醒 AI 决策 —— 待定买入/跳过". */
  statusLine?: string;
}

/**
 * Canonical trade-signal card shared by ALL sources — keep every trade-signal
 * channel post rendering through here so they stay visually aligned.
 */
export function formatSignalCard(m: SignalCardModel): string {
  const lines = [
    `🎯 **${m.symbol ?? "?"}** [${m.chain.toUpperCase()}]` +
      (m.primaryPair ? ` — ${m.primaryPair}` : "") +
      (m.badge ? ` · ${m.badge}` : ""),
    `CA: \`${m.address}\``,
    tokenLinks(m.chain, m.address, m.primaryPairAddress),
  ];
  if (m.launchAt) lines.push(`发射: ${discordTs(m.launchAt, "f")} (${discordTs(m.launchAt)})`);
  if (m.firstAt)
    lines.push(
      `首次触发: ${discordTs(m.firstAt)}` +
        (m.repeatCount && m.repeatCount > 1 && m.lastAt
          ? ` · 🔁 **第 ${m.repeatCount} 次触发** ${discordTs(m.lastAt)}`
          : ""),
    );
  for (const l of m.extraLines ?? []) if (l) lines.push(l);
  // 最新 line only when there's actually market data / triggers to show — a
  // news-only card (no price/liq) omits it instead of printing "最新: ? · 流动性 $0K".
  const hasMarket =
    m.priceUsd != null ||
    m.liquidityUsd != null ||
    m.fdvUsd != null ||
    (m.triggers?.length ?? 0) > 0;
  if (hasMarket) {
    const price = m.priceUsd != null ? `$${m.priceUsd.toPrecision(4)}` : "?";
    const liq = `$${Math.round((m.liquidityUsd ?? 0) / 1e3)}K`;
    const trig =
      m.triggers && m.triggers.length ? ` · 触发器 ${m.triggers.slice(0, 3).join(",")}` : "";
    lines.push(`最新: ${price} · 流动性 ${liq}${fdvTag(m.fdvUsd)}${trig}`);
  }
  if (m.statusLine) lines.push(m.statusLine);
  return lines.join("\n");
}
