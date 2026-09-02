#!/usr/bin/env node
import { loadEnv } from "../lib/env.js";
loadEnv();

import { runDailyReview } from "../review/daily.js";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const result = await runDailyReview({ dryRun });
  if (!dryRun) console.log(result.report);
  console.log(
    `\nreview done: ${result.graded.length} graded, ${result.movers.length} movers, ` +
      `tuner ${result.tune.adopted ? "ADOPTED " + JSON.stringify(result.tune.changes) : "no change"}, ` +
      `pushed=${result.pushed}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
