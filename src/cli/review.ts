#!/usr/bin/env node
import { loadEnv } from "../lib/env.js";
loadEnv();

import { confirmMovers, runDailyReview } from "../review/daily.js";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const confirm = process.argv.includes("--confirm");

  if (confirm) {
    const excludeArg = process.argv.find((a) => a.startsWith("--exclude="));
    const exclude = excludeArg
      ? excludeArg
          .split("=")[1]
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n))
      : [];
    const result = await confirmMovers(exclude, { dryRun });
    if ("error" in result) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(
      `\nconfirmed=${result.confirmed.length} excluded=${result.excluded.length} ` +
        `tuner=${result.tune.adopted ? "ADOPTED " + JSON.stringify(result.tune.changes) : "no change"} pushed=${result.pushed}`,
    );
    return;
  }

  const result = await runDailyReview({ dryRun });
  console.log(
    `\nreview done: ${result.graded.length} graded, ${result.movers.length} movers, ` +
      `${result.candidates.length} awaiting confirmation`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
