import { ALL_FIXTURES } from "./fixtures.js";
import {
  formatReplayReport,
  replayTokenHistory,
  type TokenReplayResult,
} from "./historical-replay.js";

export async function runHistoricalBacktest(): Promise<TokenReplayResult[]> {
  const results: TokenReplayResult[] = [];
  for (const fixture of ALL_FIXTURES) {
    results.push(await replayTokenHistory(fixture));
  }
  return results;
}

export { formatReplayReport, replayTokenHistory };
export type { TokenReplayResult };
