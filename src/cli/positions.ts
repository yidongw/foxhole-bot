#!/usr/bin/env node
import { loadEnv } from "../lib/env.js";
loadEnv();

import { formatPortfolioReport } from "../trade/engine.js";

async function main() {
  console.log(await formatPortfolioReport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
