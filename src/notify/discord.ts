/** Discord webhook — no discord.js dependency needed for alerts. */
export async function sendDiscordMessage(
  webhookUrl: string,
  content: string,
): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 2000) }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord webhook ${res.status}: ${text}`);
  }
}
