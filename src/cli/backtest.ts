#!/usr/bin/env node
import {
  runHistoricalBacktest,
  formatReplayReport,
} from "../backtest/runner.js";

async function main() {
  console.log("Fetching real OHLCV from DexPaprika and replaying monitor…\n");
  const results = await runHistoricalBacktest();
  console.log(formatReplayReport(results));

  const failed = results.filter((r) => !r.passed);
  if (failed.length) {
    console.error(`\n${failed.length} case(s) FAILED`);
    process.exit(1);
  }
  console.log("\n✅ All pump tokens alerted before peak; controls stayed quiet.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
