#!/usr/bin/env node
import { runMonitorLoop } from "../monitor/scan.js";
import type { AlertLevel } from "../signals/types.js";

async function main() {
  const once = process.argv.includes("--once");
  const dryRun = process.argv.includes("--dry-run");
  const refresh = !process.argv.includes("--no-refresh");

  let minLevel: AlertLevel = "watch";
  const levelArg = process.argv.find((a) => a.startsWith("--min="));
  if (levelArg) {
    minLevel = levelArg.split("=")[1] as AlertLevel;
  }

  if (!process.env.DISCORD_WEBHOOK_URL && !dryRun) {
    console.warn("DISCORD_WEBHOOK_URL not set — alerts will print to stdout");
  }

  await runMonitorLoop({
    once,
    dryRun,
    refreshLaunches: refresh,
    minLevel,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
