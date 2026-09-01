import { analyzeToken } from "../long/analyze-token.js";
import { BONER_BACKTEST_CASES } from "./boner-cases.js";
import { evaluateSignal, analysisToSignalInput } from "../signals/evaluate.js";
import { BONER_ADDRESS } from "../signals/config.js";
import type { AlertLevel, BacktestCase } from "../signals/types.js";
import { LEVEL_RANK } from "../signals/types.js";

export interface BacktestResult {
  caseId: string;
  label: string;
  date: string;
  expectedMin: AlertLevel;
  expectedMax?: AlertLevel;
  actual: AlertLevel;
  score: number;
  reasons: string[];
  passed: boolean;
}

export function runBacktestCases(cases: BacktestCase[]): BacktestResult[] {
  return cases.map((c) => {
    const ev = evaluateSignal(c.input);
    const actual = ev.level;
    let passed = LEVEL_RANK[actual] >= LEVEL_RANK[c.minLevel];
    if (c.maxLevel != null && LEVEL_RANK[actual] > LEVEL_RANK[c.maxLevel]) {
      passed = false;
    }
    return {
      caseId: c.id,
      label: c.label,
      date: c.date,
      expectedMin: c.minLevel,
      expectedMax: c.maxLevel,
      actual,
      score: ev.score,
      reasons: ev.reasons,
      passed,
    };
  });
}

export function formatBacktestReport(results: BacktestResult[]): string {
  const passed = results.filter((r) => r.passed).length;
  const lines = [
    `Backtest: ${passed}/${results.length} passed`,
    "",
    ...results.map((r) => {
      const mark = r.passed ? "✅" : "❌";
      const range = r.expectedMax
        ? `${r.expectedMin}–${r.expectedMax}`
        : `≥${r.expectedMin}`;
      return [
        `${mark} ${r.date} ${r.label}`,
        `   expected ${range}, got ${r.actual} (score ${r.score})`,
        `   ${r.reasons.join(" · ") || "(no reasons)"}`,
      ].join("\n");
    }),
  ];
  return lines.join("\n");
}

/** Live sanity check: run rules on current BONER on-chain data. */
export async function backtestLiveBoner(): Promise<{
  evaluation: ReturnType<typeof evaluateSignal>;
  note: string;
}> {
  const analysis = await analyzeToken(BONER_ADDRESS);
  const input = analysisToSignalInput(analysis);
  const evaluation = evaluateSignal(input);
  return {
    evaluation,
    note: "Live check uses current metrics — historical replay uses boner-cases.ts",
  };
}

export function runBonerBacktest(): BacktestResult[] {
  return runBacktestCases(BONER_BACKTEST_CASES);
}
