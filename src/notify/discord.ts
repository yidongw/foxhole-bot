import { sleep } from "../lib/utils.js";

/** Discord webhook — no discord.js dependency needed for alerts. */
export async function sendDiscordMessage(
  webhookUrl: string,
  content: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 2000) }),
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
