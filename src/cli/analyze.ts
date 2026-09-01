#!/usr/bin/env node
import { analyzeToken, formatAnalysisReport } from "../long/analyze-token.js";

async function main() {
  const address = process.argv[2];
  if (!address) {
    console.error("Usage: foxhole analyze <token-address>");
    process.exit(1);
  }
  const analysis = await analyzeToken(address);
  console.log(formatAnalysisReport(analysis));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
