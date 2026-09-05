import { describe, it, expect } from "vitest";

import { formatSignalCard } from "../src/lib/format.js";

describe("formatSignalCard (shared trade-signal card)", () => {
  it("renders the canonical monitor card (header/CA/links/最新)", () => {
    const card = formatSignalCard({
      chain: "robinhood",
      symbol: "RIDE",
      address: "0xabc",
      primaryPair: "RIDE/RIVN",
      primaryPairAddress: "0xpair",
      priceUsd: 0.002583,
      liquidityUsd: 157000,
      fdvUsd: 2600000,
      triggers: ["high_volume", "launch_watch", "momentum_strong"],
    });
    const lines = card.split("\n");
    expect(lines[0]).toBe("🎯 **RIDE** [ROBINHOOD] — RIDE/RIVN");
    expect(lines[1]).toBe("CA: `0xabc`");
    expect(lines[2]).toContain("[📈 DexScreener]");
    expect(lines[2]).toContain("[🦎 GT]");
    expect(card).toContain("最新: $0.002583 · 流动性 $157K · FDV $2.6M · 触发器 high_volume,launch_watch,momentum_strong");
  });

  it("smart-money: badge in header, extra + status lines, keeps skeleton", () => {
    const card = formatSignalCard({
      chain: "robinhood",
      symbol: "VenusCoin",
      address: "0xdef",
      primaryPairAddress: "0xp2",
      priceUsd: 151.36,
      liquidityUsd: 121000,
      badge: "🐳 聪明钱",
      extraLines: ["窗口内 **1** 个追踪钱包买入", "最近:`S v2 胜率43% $327k`"],
      statusLine: "🤖 已唤醒 AI 决策 —— 待定买入/跳过",
    });
    const lines = card.split("\n");
    expect(lines[0]).toBe("🎯 **VenusCoin** [ROBINHOOD] · 🐳 聪明钱");
    expect(lines[1]).toBe("CA: `0xdef`");
    expect(lines[2]).toContain("[📈 DexScreener]");
    expect(card).toContain("窗口内 **1** 个追踪钱包买入");
    expect(card).toContain("最新: $151.4 · 流动性 $121K");
    expect(lines[lines.length - 1]).toBe("🤖 已唤醒 AI 决策 —— 待定买入/跳过");
  });

  it("news: same skeleton but the market 最新 line is omitted when no data", () => {
    const card = formatSignalCard({
      chain: "robinhood",
      symbol: "GRASS",
      address: "0xg",
      badge: "📰 新闻",
      extraLines: ["首条新闻: <t:1:R> — GRASS 市值破 ATH"],
    });
    expect(card.split("\n")[0]).toBe("🎯 **GRASS** [ROBINHOOD] · 📰 新闻");
    expect(card).toContain("首条新闻:");
    expect(card).not.toContain("最新:");
    expect(card).not.toContain("流动性 $0K");
  });
});
