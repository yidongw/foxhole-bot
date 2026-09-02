import { readFile, writeFile } from "node:fs/promises";

import {
  loadSignalConfig,
  clearSignalConfigCache,
  OVERRIDES_PATH,
  SIGNAL_CONFIG,
  type SignalConfig,
  type SignalOverridesFile,
} from "../signals/config.js";
import { ALL_FIXTURES } from "../backtest/fixtures.js";
import { replayTokenHistory } from "../backtest/historical-replay.js";
import { replayHourlyCase, type ReviewCase } from "./cases.js";

/** Tuner sleeps until the case library has this many labeled/missed cases. */
export const MIN_CASES_TO_TUNE = 5;

/** Bounded step ladders; a candidate may move each param ≤1 step per day. */
const STEP_LADDERS: Partial<Record<keyof SignalConfig, number[]>> = {
  minVolumeUsd: [50_000, 75_000, 100_000, 150_000],
  lockAlert: [0.25, 0.3, 0.35],
  lockStrong: [0.4, 0.45, 0.5],
  volumeSpikeAlert: [3, 4, 5, 6],
  volumeSpikeStrong: [6, 8, 10],
  volumeAccelAlert: [1.5, 2, 2.5, 3],
  volumeAccelStrong: [2.5, 3, 4, 5],
  priceMomentumAlert: [10, 15, 20, 25],
  priceMomentumStrong: [30, 40, 50],
  curveNearAlert: [0.7, 0.8, 0.85],
};

interface CaseScores {
  winsCaptured: number;
  missesCaptured: number;
  falseAlerts: number;
  net: number;
}

export function scoreCases(cases: ReviewCase[], config: SignalConfig): CaseScores {
  let winsCaptured = 0;
  let missesCaptured = 0;
  let falseAlerts = 0;
  for (const kase of cases) {
    const r = replayHourlyCase(kase, config);
    if (kase.source === "win" && r.passed) winsCaptured++;
    if (kase.source === "missed" && r.passed) missesCaptured++;
    if (kase.source === "loss" && !r.passed) falseAlerts++;
  }
  return {
    winsCaptured,
    missesCaptured,
    falseAlerts,
    net: winsCaptured + missesCaptured - falseAlerts,
  };
}

function neighborSteps(param: keyof SignalConfig, current: number): number[] {
  const ladder = STEP_LADDERS[param];
  if (!ladder) return [];
  let idx = ladder.findIndex((v) => v >= current);
  if (idx === -1) idx = ladder.length - 1;
  const out: number[] = [];
  if (idx > 0) out.push(ladder[idx - 1]);
  if (idx < ladder.length - 1) out.push(ladder[idx + 1]);
  return out.filter((v) => v !== current);
}

/** All configs within one step on one or two parameters of `current`. */
export function generateCandidates(
  current: SignalConfig,
): Array<{ config: SignalConfig; changes: Partial<SignalConfig> }> {
  const params = Object.keys(STEP_LADDERS) as (keyof SignalConfig)[];
  const singles: Array<{ config: SignalConfig; changes: Partial<SignalConfig> }> = [];

  for (const p of params) {
    for (const v of neighborSteps(p, current[p] as number)) {
      singles.push({
        config: { ...current, [p]: v },
        changes: { [p]: v } as Partial<SignalConfig>,
      });
    }
  }

  const doubles: typeof singles = [];
  for (let i = 0; i < singles.length; i++) {
    for (let j = i + 1; j < singles.length; j++) {
      const a = singles[i].changes;
      const b = singles[j].changes;
      const [pa] = Object.keys(a);
      const [pb] = Object.keys(b);
      if (pa === pb) continue;
      doubles.push({
        config: { ...current, ...a, ...b },
        changes: { ...a, ...b },
      });
    }
  }
  return [...singles, ...doubles];
}

export interface TuneResult {
  eligible: boolean;
  adopted: boolean;
  reason: string;
  current: CaseScores;
  best?: CaseScores;
  changes?: Partial<SignalConfig>;
  candidatesTried?: number;
}

async function baseFixturesPass(config: SignalConfig): Promise<boolean> {
  for (const fixture of ALL_FIXTURES) {
    const r = await replayTokenHistory(fixture, { config });
    if (!r.passed) return false;
  }
  return true;
}

/**
 * Bounded auto-tune. Acceptance (all required):
 *  a. all base fixtures pass          b. wins captured >= current
 *  c. misses captured > current       d. false alerts <= current
 *  e. net strictly better
 */
export async function tuneSignalConfig(cases: ReviewCase[]): Promise<TuneResult> {
  const current = loadSignalConfig();
  const currentScores = scoreCases(cases, current);

  if (cases.length < MIN_CASES_TO_TUNE) {
    return {
      eligible: false,
      adopted: false,
      reason: `case library too small (${cases.length}/${MIN_CASES_TO_TUNE}) — collecting evidence`,
      current: currentScores,
    };
  }

  const candidates = generateCandidates(current);
  let best:
    | { config: SignalConfig; changes: Partial<SignalConfig>; scores: CaseScores }
    | undefined;

  for (const candidate of candidates) {
    const scores = scoreCases(cases, candidate.config);
    if (scores.winsCaptured < currentScores.winsCaptured) continue;
    if (scores.missesCaptured <= currentScores.missesCaptured) continue;
    if (scores.falseAlerts > currentScores.falseAlerts) continue;
    if (scores.net <= currentScores.net) continue;
    if (
      !best ||
      scores.net > best.scores.net ||
      (scores.net === best.scores.net &&
        scores.falseAlerts < best.scores.falseAlerts) ||
      (scores.net === best.scores.net &&
        scores.falseAlerts === best.scores.falseAlerts &&
        Object.keys(candidate.changes).length < Object.keys(best.changes).length)
    ) {
      best = { ...candidate, scores };
    }
  }

  if (!best) {
    return {
      eligible: true,
      adopted: false,
      reason:
        "no candidate improves miss-capture without hurting wins/false-alerts — today's misses are not threshold-fixable",
      current: currentScores,
      candidatesTried: candidates.length,
    };
  }

  // Final absolute gate: the historical daily fixtures must still pass.
  if (!(await baseFixturesPass(best.config))) {
    return {
      eligible: true,
      adopted: false,
      reason: "best candidate regressed the base fixtures — rejected",
      current: currentScores,
      best: best.scores,
      changes: best.changes,
      candidatesTried: candidates.length,
    };
  }

  await adoptOverrides(best.config, best.changes, best.scores, currentScores);
  return {
    eligible: true,
    adopted: true,
    reason: "candidate captures more misses with no new false alerts",
    current: currentScores,
    best: best.scores,
    changes: best.changes,
    candidatesTried: candidates.length,
  };
}

async function adoptOverrides(
  config: SignalConfig,
  changes: Partial<SignalConfig>,
  scores: CaseScores,
  before: CaseScores,
): Promise<void> {
  // Persist the full diff vs compiled defaults (not just today's changes).
  const diff: Partial<SignalConfig> = {};
  for (const key of Object.keys(config) as (keyof SignalConfig)[]) {
    if (config[key] !== SIGNAL_CONFIG[key]) {
      (diff as Record<string, unknown>)[key] = config[key];
    }
  }

  let existing: SignalOverridesFile | undefined;
  try {
    existing = JSON.parse(await readFile(OVERRIDES_PATH, "utf8")) as SignalOverridesFile;
  } catch {}

  const reason =
    `misses ${before.missesCaptured}→${scores.missesCaptured}, ` +
    `false alerts ${before.falseAlerts}→${scores.falseAlerts}, ` +
    `wins held at ${scores.winsCaptured}`;
  const file: SignalOverridesFile = {
    updated_at: new Date().toISOString(),
    reason,
    config: diff,
    history: [
      ...(existing?.history ?? []),
      { at: new Date().toISOString(), reason, config: changes },
    ].slice(-50),
  };
  await writeFile(OVERRIDES_PATH, JSON.stringify(file, null, 2), "utf8");
  clearSignalConfigCache();
}
