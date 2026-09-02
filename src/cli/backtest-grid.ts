#!/usr/bin/env node
import { loadEnv } from "../lib/env.js";
loadEnv();

import { fetchPoolOhlcv, type OhlcvCandle } from "../dex/dexpaprika.js";
import { SIGNAL_CONFIG, type SignalConfig } from "../signals/config.js";
import { ALL_FIXTURES } from "../backtest/fixtures.js";
import {
  replayCandles,
  type TokenBacktestFixture,
} from "../backtest/historical-replay.js";
import { sleep } from "../lib/utils.js";

/**
 * Parameter grid search over the fixture set. Scores each config by:
 *  1. fixtures passed (primary)
 *  2. average alert lead time before the pump peak (days, higher better)
 *  3. fewer control alert-days (tie-break)
 */

const GRID = {
  lockAlert: [0.25, 0.3, 0.35],
  lockStrong: [0.4, 0.45, 0.5],
  volumeAccelAlert: [2, 2.5, 3],
  priceMomentumAlert: [15, 20, 25],
};

interface GridResult {
  overrides: Record<string, number>;
  passed: number;
  total: number;
  avgLeadDays: number;
  controlAlertDays: number;
}

function* combos(): Generator<Record<string, number>> {
  for (const lockAlert of GRID.lockAlert)
    for (const lockStrong of GRID.lockStrong)
      for (const volumeAccelAlert of GRID.volumeAccelAlert)
        for (const priceMomentumAlert of GRID.priceMomentumAlert)
          yield { lockAlert, lockStrong, volumeAccelAlert, priceMomentumAlert };
}

async function main() {
  console.log(`Fetching OHLCV for ${ALL_FIXTURES.length} fixtures (once)…`);
  const candlesByFixture = new Map<TokenBacktestFixture, OhlcvCandle[]>();
  for (const fixture of ALL_FIXTURES) {
    candlesByFixture.set(
      fixture,
      await fetchPoolOhlcv(fixture.poolId, {
        start: fixture.ohlcvStart,
        interval: "24h",
        limit: 120,
        network: fixture.network,
      }),
    );
    await sleep(300);
  }

  const results: GridResult[] = [];
  for (const overrides of combos()) {
    const config: SignalConfig = { ...SIGNAL_CONFIG, ...overrides };
    let passed = 0;
    let leadSum = 0;
    let leadCount = 0;
    let controlAlertDays = 0;

    for (const [fixture, candles] of candlesByFixture) {
      const r = replayCandles(fixture, candles, { config });
      if (r.passed) passed++;
      if (fixture.kind === "pump" && r.firstAlertDate) {
        const lead =
          (new Date(r.peakDate).getTime() - new Date(r.firstAlertDate).getTime()) /
          86_400_000;
        leadSum += lead;
        leadCount++;
      }
      if (fixture.kind === "control") controlAlertDays += r.alerts.length;
    }

    results.push({
      overrides,
      passed,
      total: ALL_FIXTURES.length,
      avgLeadDays: leadCount ? leadSum / leadCount : 0,
      controlAlertDays,
    });
  }

  results.sort(
    (a, b) =>
      b.passed - a.passed ||
      b.avgLeadDays - a.avgLeadDays ||
      a.controlAlertDays - b.controlAlertDays,
  );

  console.log(`\nTop 10 of ${results.length} configs (current config marked ●):\n`);
  const current = JSON.stringify({
    lockAlert: SIGNAL_CONFIG.lockAlert,
    lockStrong: SIGNAL_CONFIG.lockStrong,
    volumeAccelAlert: SIGNAL_CONFIG.volumeAccelAlert,
    priceMomentumAlert: SIGNAL_CONFIG.priceMomentumAlert,
  });
  for (const r of results.slice(0, 10)) {
    const marker = JSON.stringify(r.overrides) === current ? "●" : " ";
    console.log(
      `${marker} ${r.passed}/${r.total} passed | lead ${r.avgLeadDays.toFixed(1)}d | ctrl-alerts ${r.controlAlertDays} | ${JSON.stringify(r.overrides)}`,
    );
  }
  const rank = results.findIndex((r) => JSON.stringify(r.overrides) === current);
  console.log(`\nCurrent SIGNAL_CONFIG ranks #${rank + 1} of ${results.length}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
