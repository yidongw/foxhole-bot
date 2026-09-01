#!/usr/bin/env node
import { runBonerBacktest, formatBacktestReport, backtestLiveBoner } from "../backtest/runner.js";

async function main() {
  const live = process.argv.includes("--live");

  console.log("=== BONER historical backtest ===\n");
  const results = runBonerBacktest();
  console.log(formatBacktestReport(results));

  const allPassed = results.every((r) => r.passed);
  if (!allPassed) {
    console.error("\nBacktest FAILED — tune signals/config.ts");
    process.exit(1);
  }

  console.log("\n✅ All historical BONER cases passed.");
  console.log("   Aug 28 spike → alert before weekend pump ✓\n");

  if (live) {
    console.log("=== Live BONER check (current on-chain) ===\n");
    const { evaluation, note } = await backtestLiveBoner();
    console.log(note);
    console.log(`Level: ${evaluation.level} | Score: ${evaluation.score}`);
    console.log(evaluation.reasons.map((r) => `  • ${r}`).join("\n"));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
