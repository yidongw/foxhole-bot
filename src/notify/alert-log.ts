import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALERTS_PATH = path.resolve(__dirname, "../../web/data/alerts.json");
const MAX_ENTRIES = 50;

interface AlertEntry {
  at: string;
  body: string;
}

/** Ring-buffer alert feed for the dashboard. Best-effort; never throws. */
export async function appendAlertLog(body: string): Promise<void> {
  try {
    let entries: AlertEntry[] = [];
    try {
      const raw = await readFile(ALERTS_PATH, "utf8");
      entries = (JSON.parse(raw) as { alerts?: AlertEntry[] }).alerts ?? [];
    } catch {
      // first write
    }
    entries.push({ at: new Date().toISOString(), body });
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
    await mkdir(path.dirname(ALERTS_PATH), { recursive: true });
    await writeFile(
      ALERTS_PATH,
      JSON.stringify({ meta: { updated_at: new Date().toISOString() }, alerts: entries }, null, 2),
      "utf8",
    );
  } catch (err) {
    console.error("alert log write failed:", (err as Error).message);
  }
}
