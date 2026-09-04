import Anthropic from "@anthropic-ai/sdk";

import type { Position } from "./positions.js";
import { remainingFraction } from "./positions.js";

export interface AdvisorContext {
  currentPriceUsd: number;
  lockRatio?: number;
  volume24hUsd?: number;
  priceChange24h?: number;
  quotePremium?: number;
}

export interface AdvisorDecision {
  action: "hold" | "exit";
  confidence: number;
  reason: string;
}

/** Minimum time between advisor calls per position. */
export const ADVISOR_COOLDOWN_MS = 60 * 60 * 1000;

const SYSTEM_PROMPT = `You are the exit advisor for a Robinhood Chain meme-token trading bot.
The bot already has deterministic hard stops, trailing stops, and tiered
take-profits — those always execute and are NOT your concern. Your only job
is to spot situations where an EARLY exit beats waiting for those rails:
collapsing volume after a blow-off top, a squeeze that has clearly resolved
(lock ratio dropping fast), or momentum death in a position going nowhere.

Meme squeezes are volatile by nature — ordinary drawdown or chop is NOT a
reason to exit; the trailing stop handles that. Recommend "exit" only when
the thesis that justified entry is broken.

Respond with ONLY a JSON object, no prose:
{"action": "hold" | "exit", "confidence": 0.0-1.0, "reason": "<one sentence>"}`;

function isEnabled(): boolean {
  return (
    process.env.TRADE_LLM_ADVISOR === "1" && Boolean(process.env.ANTHROPIC_API_KEY)
  );
}

export function advisorAvailable(): boolean {
  return isEnabled();
}

let anthropic: Anthropic | undefined;

function getClient(): Anthropic {
  if (!anthropic) anthropic = new Anthropic();
  return anthropic;
}

function describePosition(p: Position, ctx: AdvisorContext): string {
  const heldHours =
    (Date.now() - new Date(p.openedAt).getTime()) / 3_600_000;
  const pnlPct = ((ctx.currentPriceUsd / p.entryPriceUsd - 1) * 100).toFixed(1);
  const offHighPct = (
    (1 - ctx.currentPriceUsd / Math.max(p.highWaterUsd, ctx.currentPriceUsd)) * 100
  ).toFixed(1);
  return JSON.stringify({
    symbol: p.symbol,
    entryTrigger: p.trigger,
    plan: p.strategy?.note,
    heldHours: Math.round(heldHours * 10) / 10,
    remainingFraction: remainingFraction(p),
    entryPriceUsd: p.entryPriceUsd,
    currentPriceUsd: ctx.currentPriceUsd,
    pnlPct: Number(pnlPct),
    pctOffHighWater: Number(offHighPct),
    exitsSoFar: p.exits.map((e) => e.reason),
    market: {
      quoteLockRatio: ctx.lockRatio,
      volume24hUsd: ctx.volume24hUsd,
      priceChange24h: ctx.priceChange24h,
      quotePremium: ctx.quotePremium,
    },
  });
}

/**
 * Ask Claude whether to exit early. Fail-safe: any error, parse failure, or
 * low confidence resolves to "hold" — the deterministic rails still apply.
 */
export async function adviseExit(
  position: Position,
  ctx: AdvisorContext,
): Promise<AdvisorDecision> {
  const hold: AdvisorDecision = { action: "hold", confidence: 0, reason: "advisor unavailable" };
  if (!isEnabled()) return hold;

  try {
    const model = process.env.TRADE_ADVISOR_MODEL ?? "claude-opus-5";
    const response = await getClient().messages.create({
      model,
      max_tokens: 1000,
      output_config: { effort: "low" },
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: describePosition(position, ctx) },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { ...hold, reason: "advisor returned no JSON" };

    const parsed = JSON.parse(match[0]) as Partial<AdvisorDecision>;
    if (parsed.action !== "exit" && parsed.action !== "hold") {
      return { ...hold, reason: "advisor returned invalid action" };
    }
    return {
      action: parsed.action,
      confidence: Math.min(Math.max(Number(parsed.confidence) || 0, 0), 1),
      reason: String(parsed.reason ?? "").slice(0, 300),
    };
  } catch (err) {
    console.error("advisor call failed:", (err as Error).message);
    return { ...hold, reason: "advisor error" };
  }
}
