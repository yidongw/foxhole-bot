#!/usr/bin/env node
import path from "node:path";
import os from "node:os";

import { loadEnv } from "../lib/env.js";
loadEnv();

import { runMonitorLoop } from "../monitor/scan.js";
import { acquireSingleInstanceLock } from "../lib/single-instance.js";
import type { AlertLevel } from "../signals/types.js";

async function main() {
  const once = process.argv.includes("--once");
  const dryRun = process.argv.includes("--dry-run");
  const refresh = !process.argv.includes("--no-refresh");

  // Single-instance guard for the long-running daemon only (not one-shot --once
  // scans). Stops a stray `npm run monitor` from double-firing signals /
  // double-executing live trades alongside the launchd instance.
  if (!once) {
    const lockPath = path.join(os.tmpdir(), "foxhole-monitor.lock");
    if (!acquireSingleInstanceLock(lockPath)) {
      console.error(
        "[monitor] another monitor instance is already running — exiting (single-instance lock)",
      );
      process.exit(0);
    }
  }

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
