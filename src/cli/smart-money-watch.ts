#!/usr/bin/env node
import { loadEnv } from "../lib/env.js";
loadEnv();

import { startSmartMoneyWatcher } from "../chains/robinhood/smart-money-watcher.js";
import { startActivityWatcher } from "../smartmoney/activity-watcher.js";
import { startCieloWatcher } from "../smartmoney/cielo.js";
import { startDashboardWriter } from "../smartmoney/dashboard.js";

/**
 * Run ONLY the smart-money watcher (no discovery / trading / other channels).
 * Optional first arg = minutes to run before self-exit (0 / omitted = forever).
 *   tsx src/cli/smart-money-watch.ts [minutes]
 */
const minutes = Number(process.argv[2] ?? 0);
if (minutes > 0) {
  setTimeout(
    () => {
      console.log(`[smart-money] test window of ${minutes}min elapsed — exiting.`);
      process.exit(0);
    },
    minutes * 60_000,
  ).unref();
}

console.log(
  `[smart-money] standalone watch starting${minutes > 0 ? ` for ${minutes}min` : ""}…`,
);
startSmartMoneyWatcher().catch((err) => {
  console.error("RB watcher:", (err as Error).message);
});
startActivityWatcher().catch((err) => {
  console.error("activity watcher:", (err as Error).message);
});
startCieloWatcher().catch((err) => {
  console.error("cielo watcher:", (err as Error).message);
});
startDashboardWriter().catch((err) => {
  console.error("dashboard writer:", (err as Error).message);
});
