import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { enabledChains } from "../chains/adapter.js";
import { loadMonitorState } from "../monitor/state.js";
import { sendDiscordMessage } from "../notify/discord.js";
import { appendAlertLog } from "../notify/alert-log.js";
import {
  gradePendingOutcomes,
  loadLabeledOutcomes,
  loadPendingOutcomes,
  type LabeledOutcome,
} from "./ledger.js";
import {
  loadMissedCases,
  scanMissedMovers,
  type ClassifiedMover,
} from "./movers.js";
import { buildCaseLibrary } from "./cases.js";
import { tuneSignalConfig, type TuneResult } from "./tuner.js";
import { analyzeDailyReview } from "./analyst.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const REVIEW_WEB_PATH = path.join(ROOT, "web/data/review.json");

export interface DailyReviewResult {
  graded: LabeledOutcome[];
  movers: ClassifiedMover[];
  tune: TuneResult;
  narrative?: string;
  report: string;
  pushed: boolean;
}

function pct(n?: number): string {
  return n == null ? "?" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}%`;
}

function buildReport(
  graded: LabeledOutcome[],
  movers: ClassifiedMover[],
  tune: TuneResult,
  narrative?: string,
): string {
  const wins = graded.filter((g) => g.outcome === "win");
  const losses = graded.filter((g) => g.outcome === "loss");
  const flats = graded.filter((g) => g.outcome === "flat");
  const ladders = movers.filter((m) => m.ladder);
  const missed = movers.filter((m) => m.kind !== "alerted" && !m.ladder);
  const alerted = movers.filter((m) => m.kind === "alerted");

  const lines = [`📊 **每日复盘 / Daily Review** — ${new Date().toISOString().slice(0, 10)}`];

  if (graded.length) {
    lines.push(
      `Alerts graded: ${graded.length} — ✅ ${wins.length} win, ⚪ ${flats.length} flat, ❌ ${losses.length} false`,
    );
    for (const w of wins.slice(0, 4)) {
      lines.push(`  ✅ ${w.symbol} [${w.chain}] ${pct(w.maxReturn)} after ${w.triggers.slice(0, 2).join("+")}`);
    }
    for (const l of losses.slice(0, 4)) {
      lines.push(`  ❌ ${l.symbol} [${l.chain}] ${pct(l.minReturn)} — triggers: ${l.triggers.slice(0, 3).join(",")}`);
    }
  } else {
    lines.push("Alerts graded: none due yet");
  }

  lines.push(
    `暴涨 scan: ${movers.length} movers ≥+100% — ${alerted.length} alerted ✅, ` +
      `${missed.filter((m) => m.kind === "threshold_miss").length} threshold-miss, ` +
      `${missed.filter((m) => m.kind === "coverage_miss").length} coverage-miss`,
  );
  for (const m of missed.slice(0, 5)) {
    lines.push(
      `  🕳️ ${m.symbol ?? m.address.slice(0, 8)} [${m.chain}] +${m.priceChange24h.toFixed(0)}% (${m.kind})`,
    );
  }
  if (ladders.length) {
    lines.push(
      `  🪜 已过滤刷单画线盘 ${ladders.length} 个: ${ladders.slice(0, 4).map((m) => m.symbol ?? m.address.slice(0, 8)).join(", ")}`,
    );
  }

  if (tune.adopted) {
    lines.push(
      `🔧 Tuner ADOPTED: ${JSON.stringify(tune.changes)} — ${tune.reason}`,
    );
  } else {
    lines.push(`🔧 Tuner: no change — ${tune.reason}`);
  }

  if (narrative) lines.push("", narrative);
  return lines.join("\n");
}

async function autoPush(tune: TuneResult): Promise<boolean> {
  if (!tune.adopted || process.env.AUTO_TUNE_PUSH !== "1") return false;
  try {
    await execFileAsync("git", ["add", "data/signal-overrides.json", "data/outcomes"], {
      cwd: ROOT,
    });
    await execFileAsync(
      "git",
      [
        "commit",
        "-m",
        `Auto-tune: ${JSON.stringify(tune.changes)} (${tune.reason})\n\nAdopted by the daily self-review loop; gates: base fixtures pass,\nwins held, misses captured up, false alerts not increased.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>`,
      ],
      { cwd: ROOT },
    );
    await execFileAsync("git", ["push", "origin", "HEAD"], { cwd: ROOT });
    return true;
  } catch (err) {
    console.error("auto-push failed:", (err as Error).message);
    return false;
  }
}

export async function runDailyReview(options: {
  dryRun?: boolean;
  webhookUrl?: string;
} = {}): Promise<DailyReviewResult> {
  console.log("daily review: grading outcomes…");
  const graded = await gradePendingOutcomes();

  console.log("daily review: scanning movers…");
  const state = await loadMonitorState();
  const ledger = [...(await loadLabeledOutcomes()), ...(await loadPendingOutcomes())];
  const movers = await scanMissedMovers(enabledChains(), state, ledger);

  console.log("daily review: building case library + tuning…");
  const library = await buildCaseLibrary(
    await loadLabeledOutcomes(),
    await loadMissedCases(),
  );
  const tune = await tuneSignalConfig(library);

  const narrative = await analyzeDailyReview({ graded, movers, tune });
  const report = buildReport(graded, movers, tune, narrative);

  await mkdir(path.dirname(REVIEW_WEB_PATH), { recursive: true });
  await writeFile(
    REVIEW_WEB_PATH,
    JSON.stringify(
      {
        meta: { updated_at: new Date().toISOString() },
        graded,
        movers,
        tune: { adopted: tune.adopted, reason: tune.reason, changes: tune.changes },
        narrative,
      },
      null,
      2,
    ),
    "utf8",
  ).catch((err) => console.error("review.json write failed:", (err as Error).message));

  if (options.dryRun) {
    console.log("--- DRY RUN REVIEW ---\n" + report + "\n");
  } else {
    await appendAlertLog(report);
    const url = options.webhookUrl ?? process.env.DISCORD_WEBHOOK_URL;
    if (url) await sendDiscordMessage(url, report).catch((err) => console.error(err));
    else console.log(report);
  }

  const pushed = options.dryRun ? false : await autoPush(tune);
  return { graded, movers, tune, narrative, report, pushed };
}
