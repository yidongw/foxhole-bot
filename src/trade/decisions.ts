import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Decision journal — the decider is a fresh headless `claude -p` each wake with
 * NO session memory, so its only continuity is what the file layer surfaces
 * back into its three read faces (inbox / status). Before this, a `skip` was
 * not even a first-class decision: the decider just didn't buy and posted a
 * Discord note it could never read again. So the SAME token re-entering the
 * inbox got re-analysed from scratch — wasting the scarce single-decider window
 * and letting two passes reach opposite verdicts on identical data.
 *
 * This module persists every buy / sell / skip as a structured line with a
 * decision-time snapshot, so a later pass can see "you already skipped this
 * 25min ago: reason R (revisit: reclaim $X)" inline on the inbox item and
 * fast-path instead of redoing the work. It is soft context, never a hard
 * block (denylist already does hard blocks) — the decider may override a prior
 * verdict when the data genuinely changed, but must say why.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Overridable (DECISIONS_LOG_PATH) so tests can isolate the journal. */
function decisionsPath(): string {
  return (
    process.env.DECISIONS_LOG_PATH ??
    path.resolve(__dirname, "../../data/decisions.jsonl")
  );
}

/** How far back a prior verdict is considered relevant for inbox annotation. */
export const PRIOR_WINDOW_MS = 48 * 60 * 60_000;
/** Window for the "recently skipped, nothing changed" wake suppression. */
const REWAKE_WINDOW_MS = 2 * 60 * 60_000;
/** Price move beyond this vs the skip snapshot counts as a material change. */
const MATERIAL_PRICE_MOVE = 0.15;

export type Verdict = "buy" | "sell" | "skip";

export interface DecisionSnap {
  price?: number;
  liq?: number;
  mcap?: number;
}

export interface Decision {
  at: string;
  verdict: Verdict;
  chain: string;
  /** Coin address (lowercased) for spot; base symbol for perp/news. */
  token: string;
  symbol?: string;
  reason: string;
  /** Optional condition under which a skip is worth revisiting. */
  revisit?: string;
  snap?: DecisionSnap;
  /** Signal source / trigger for later attribution in review. */
  source?: string;
}

function key(chain: string, token: string): string {
  return `${chain.toLowerCase()}:${token.toLowerCase()}`;
}

export async function appendDecision(d: Omit<Decision, "at">): Promise<void> {
  const line: Decision = {
    at: new Date().toISOString(),
    ...d,
    reason: d.reason.slice(0, 240),
    revisit: d.revisit?.slice(0, 160),
  };
  try {
    const p = decisionsPath();
    await mkdir(path.dirname(p), { recursive: true });
    await appendFile(p, JSON.stringify(line) + "\n", "utf8");
  } catch (err) {
    // A decision-log write must never break a trade or a wake.
    console.error("decision log write failed:", (err as Error).message);
  }
}

export async function readDecisions(): Promise<Decision[]> {
  try {
    const raw = await readFile(decisionsPath(), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Decision);
  } catch {
    return [];
  }
}

/** Most recent decision for a token within `withinMs` (default 48h), if any. */
export async function priorVerdict(
  chain: string,
  token: string,
  withinMs = PRIOR_WINDOW_MS,
): Promise<Decision | undefined> {
  const k = key(chain, token);
  const cutoff = Date.now() - withinMs;
  const all = await readDecisions();
  let latest: Decision | undefined;
  for (const d of all) {
    if (key(d.chain, d.token) !== k) continue;
    if (new Date(d.at).getTime() < cutoff) continue;
    if (!latest || new Date(d.at) > new Date(latest.at)) latest = d;
  }
  return latest;
}

/** One-line human/AI annotation of a prior verdict for inbox/status display. */
export function formatPriorVerdict(d: Decision): string {
  const ageMin = Math.max(0, Math.round((Date.now() - new Date(d.at).getTime()) / 60_000));
  const age = ageMin >= 60 ? `${Math.round(ageMin / 60)}h前` : `${ageMin}分钟前`;
  const tag = { buy: "已买", sell: "已卖", skip: "已skip" }[d.verdict];
  const revisit = d.revisit ? ` (revisit: ${d.revisit})` : "";
  return `${age}${tag}: ${d.reason}${revisit}`;
}

/**
 * Stage 3 —免疫无意义的重复唤醒. Returns true when this coin was skipped inside
 * the last 2h AND we can PROVE nothing material changed (price within ±15% of
 * the skip snapshot). We only suppress when the no-change is provable; missing
 * data → do NOT suppress (a wasted decider run is cheaper than a missed mover).
 * The signal is still appended to the inbox — suppression only skips the extra
 * `claude -p` spawn; the next genuine wake or the hourly patrol still sees it.
 */
export async function suppressRewake(
  chain: string,
  token: string,
  snap: DecisionSnap,
): Promise<boolean> {
  const prior = await priorVerdict(chain, token, REWAKE_WINDOW_MS);
  if (!prior || prior.verdict !== "skip") return false;
  const then = prior.snap?.price;
  const now = snap.price;
  if (!(then && then > 0) || !(now && now > 0)) return false; // unprovable → don't suppress
  const moved = Math.abs(now / then - 1) >= MATERIAL_PRICE_MOVE;
  return !moved; // no material move since the skip → suppress the redundant wake
}

/**
 * Compact recent-decision digest for `ai-trade status`, so even the no-new-
 * signal patrol has continuity with what recent passes decided (skips first —
 * they're the ones with no other read surface). Empty string when nothing recent.
 */
export async function formatRecentDecisions(withinMs = 12 * 60 * 60_000): Promise<string> {
  const cutoff = Date.now() - withinMs;
  const recent = (await readDecisions())
    .filter((d) => new Date(d.at).getTime() >= cutoff)
    .slice(-40);
  if (!recent.length) return "";
  const tag = { buy: "🟢买", sell: "🔴卖", skip: "⚪skip" } as const;
  const lines = recent
    .slice(-15)
    .map((d) => {
      const who = d.symbol ?? d.token.slice(0, 8);
      const revisit = d.revisit ? ` ⟳${d.revisit}` : "";
      return `${tag[d.verdict]} ${who} [${d.chain}] ${d.reason.slice(0, 80)}${revisit} (${d.at.slice(5, 16)})`;
    });
  return [
    "=== 🗒️ 近期决策(含skip, 12h)===",
    ...lines,
    "参考: 同一标的再进 inbox 时会带上这条前次结论,数据没变就别推翻自己;真变了要说明改主意的理由。",
  ].join("\n");
}
