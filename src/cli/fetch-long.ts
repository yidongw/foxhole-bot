#!/usr/bin/env node
import { collectLaunches, writeLaunchesJson } from "../long/fetch-launches.js";

async function main() {
  const payload = await collectLaunches();
  await writeLaunchesJson(payload);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
