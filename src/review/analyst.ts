import Anthropic from "@anthropic-ai/sdk";

import type { LabeledOutcome } from "./ledger.js";
import type { ClassifiedMover } from "./movers.js";
import type { TuneResult } from "./tuner.js";

const SYSTEM_PROMPT = `You are the daily performance analyst for a multi-chain
meme-token alert bot. You receive one day of graded evidence: alerts that won
(pumped ≥40% after firing), false alerts (dropped ≥30%), and 暴涨 tokens the
bot missed (classified as threshold_miss = scanned but thresholds blocked, or
coverage_miss = never scanned), plus the auto-tuner's decision.

Write a concise review (≤250 words) in three parts:
1. 正反馈 — celebrate what worked: which triggers produced the wins.
2. Diagnosis — for false alerts and misses, the most likely root cause per
   case (be specific: which trigger misfired or which gate blocked).
3. Recommendations — only ideas the bounded threshold-tuner CANNOT do itself
   (new signal types, new data sources, structural changes). If the tuner
   already handled today's issues, say so and stop.

Plain text, no markdown headers. Mix short English/中文 labels as natural.`;

function isEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

let client: Anthropic | undefined;

export async function analyzeDailyReview(summary: {
  graded: LabeledOutcome[];
  movers: ClassifiedMover[];
  tune: TuneResult;
}): Promise<string | undefined> {
  if (!isEnabled()) return undefined;
  try {
    if (!client) client = new Anthropic();
    const response = await client.messages.create({
      model: process.env.REVIEW_ANALYST_MODEL ?? "claude-opus-5",
      max_tokens: 2000,
      output_config: { effort: "medium" },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            wins: summary.graded
              .filter((g) => g.outcome === "win")
              .map((g) => ({
                symbol: g.symbol,
                chain: g.chain,
                triggers: g.triggers,
                maxReturn: g.maxReturn,
              })),
            falseAlerts: summary.graded
              .filter((g) => g.outcome === "loss")
              .map((g) => ({
                symbol: g.symbol,
                chain: g.chain,
                triggers: g.triggers,
                score: g.score,
                maxReturn: g.maxReturn,
                minReturn: g.minReturn,
                liquidityUsd: g.liquidityUsd,
              })),
            missed: summary.movers
              .filter((m) => m.kind !== "alerted")
              .map((m) => ({
                symbol: m.symbol,
                chain: m.chain,
                kind: m.kind,
                priceChange24h: m.priceChange24h,
                volume24hUsd: m.volume24hUsd,
                liquidityUsd: m.liquidityUsd,
              })),
            tuner: {
              adopted: summary.tune.adopted,
              reason: summary.tune.reason,
              changes: summary.tune.changes,
            },
          }),
        },
      ],
    });
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch (err) {
    console.error("review analyst failed:", (err as Error).message);
    return undefined;
  }
}
