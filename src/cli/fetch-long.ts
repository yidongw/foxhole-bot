#!/usr/bin/env node
import { loadEnv } from "../lib/env.js";
loadEnv();

import { collectLaunches, writeLaunchesJson } from "../long/fetch-launches.js";

async function main() {
  const payload = await collectLaunches();
  await writeLaunchesJson(payload);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
