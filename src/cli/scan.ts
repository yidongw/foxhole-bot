#!/usr/bin/env node
import { loadEnv } from "../lib/env.js";
loadEnv();

import { scanLaunches } from "../monitor/scan.js";
import type { AlertLevel } from "../signals/types.js";
import { formatSignalAlert } from "../signals/evaluate.js";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  let minLevel: AlertLevel = "watch";
  const levelArg = process.argv.find((a) => a.startsWith("--min="));
  if (levelArg) minLevel = levelArg.split("=")[1] as AlertLevel;

  const hits = await scanLaunches({
    minLevel,
    refreshLaunches: true,
    dryRun,
  });

  console.log(`\nScan complete: ${hits.length} hits ≥ ${minLevel}\n`);
  for (const hit of hits) {
    console.log(formatSignalAlert(hit.evaluation));
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
