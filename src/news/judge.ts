import Anthropic from "@anthropic-ai/sdk";

import type { Flash } from "./blockbeats.js";
import type { NewsClassification } from "./filter.js";

const SYSTEM_PROMPT = `You judge crypto newsflashes for a Robinhood-Chain meme
trading bot (Long.xyz stock-paired launches; watches BSC/Base/Solana too).
Given one BlockBeats flash that passed keyword pre-filtering, answer: is this
actionable for the bot RIGHT NOW?

Actionable = a concrete tradeable catalyst (exchange/Alpha listing, RB-chain
meme momentum with a named token, whale accumulation of a watched token) or a
danger signal on a watched token (dump, fraud admission, rug, hack → exit).
NOT actionable = macro, stocks, AI-industry news, vague commentary, post-mortem
recaps of moves already finished.

Reply with ONLY a JSON object: {"signal": boolean, "urgency": "now"|"watch",
"note": "<one短句中文, ≤50字, 说清楚该做什么>"}`;

export interface NewsVerdict {
  signal: boolean;
  urgency: "now" | "watch";
  note: string;
}

let client: Anthropic | undefined;

/**
 * Claude 判定叫醒候选（ANTHROPIC_API_KEY 缺失或调用失败时 fail-open：
 * 返回 undefined，调用方按关键词命中直接推送）。
 */
export async function judgeFlash(
  flash: Flash,
  cls: NewsClassification,
): Promise<NewsVerdict | undefined> {
  if (!process.env.ANTHROPIC_API_KEY) return undefined;
  try {
    if (!client) client = new Anthropic();
    const response = await client.messages.create({
      model: process.env.NEWS_ANALYST_MODEL ?? "claude-opus-5",
      max_tokens: 1000,
      output_config: { effort: "low" },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            title: flash.title,
            content: flash.content,
            prefilterReasons: cls.reasons,
            negative: cls.negative,
          }),
        },
      ],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) return undefined;
    const parsed = JSON.parse(json[0]) as Partial<NewsVerdict>;
    if (typeof parsed.signal !== "boolean") return undefined;
    return {
      signal: parsed.signal,
      urgency: parsed.urgency === "now" ? "now" : "watch",
      note: typeof parsed.note === "string" ? parsed.note.slice(0, 100) : "",
    };
  } catch (err) {
    console.error("news judge failed (fail-open):", (err as Error).message);
    return undefined;
  }
}
