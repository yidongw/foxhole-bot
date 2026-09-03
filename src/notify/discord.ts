import { sleep } from "../lib/utils.js";

async function postWebhook(webhookUrl: string, payload: unknown): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return;
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as {
        retry_after?: number;
      };
      await sleep(Math.min((body.retry_after ?? 2) * 1000 + 100, 30_000));
      continue;
    }
    const text = await res.text();
    throw new Error(`Discord webhook ${res.status}: ${text}`);
  }
  throw new Error("Discord webhook: rate limited after 3 attempts");
}

/** Discord webhook — no discord.js dependency needed for alerts. */
export async function sendDiscordMessage(
  webhookUrl: string,
  content: string,
): Promise<void> {
  await postWebhook(webhookUrl, { content: content.slice(0, 2000) });
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  /** Decimal color for the left border (e.g. 0xF0B90B → 15776011). */
  color?: number;
  url?: string;
  footer?: { text: string };
}

/** Send a rich embed — used for color-coded (per-chain) alerts. */
export async function sendDiscordEmbed(
  webhookUrl: string,
  embed: DiscordEmbed,
): Promise<void> {
  await postWebhook(webhookUrl, { embeds: [embed] });
}
