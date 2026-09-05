import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { enabledChains } from "../chains/adapter.js";
import { fetchStockRegistry } from "../chains/robinhood/stock-registry.js";
import { loadMonitorState } from "../monitor/state.js";
import { appendAlertLog } from "../notify/alert-log.js";
import {
  gradePendingOutcomes,
  loadLabeledOutcomes,
  loadPendingOutcomes,
  type LabeledOutcome,
} from "./ledger.js";
import {
  loadMissedCases,
  MOVER_MIN_FDV_USD,
  saveMissedCases,
  scanMissedMovers,
  type ClassifiedMover,
} from "./movers.js";
import { buildCaseLibrary } from "./cases.js";
import { tuneSignalConfig, type TuneResult } from "./tuner.js";
import { analyzeDailyReview } from "./analyst.js";
import { addToDenylist } from "./denylist.js";
import { appendReviewJournal, journalHeader } from "./journal.js";
import {
  appendFilterDecisions,
  appendFilterJournal,
} from "./filter-journal.js";
import { reviewOwnTrades, type OwnTradeReview } from "./exits-review.js";
import { loadPositions } from "../trade/positions.js";
import { kvDel, kvGet, kvSet } from "../lib/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const REVIEW_WEB_PATH = path.join(ROOT, "web/data/review.json");
const OUTCOMES_DIR = path.join(ROOT, "data/outcomes");
/** Transient checklist — now DB-only (kv); a legacy JSON file is imported once. */
const PENDING_MOVERS_KV = "outcomes:pendingMovers";
const LEGACY_PENDING_MOVERS = path.join(OUTCOMES_DIR, "pending-movers.json");

interface PendingMovers {
  createdAt: string;
  movers: ClassifiedMover[];
}

function loadPendingMovers(): PendingMovers | null {
  const raw = kvGet(PENDING_MOVERS_KV);
  if (raw) return JSON.parse(raw) as PendingMovers;
  if (existsSync(LEGACY_PENDING_MOVERS)) {
    try {
      const legacy = JSON.parse(readFileSync(LEGACY_PENDING_MOVERS, "utf8")) as PendingMovers;
      kvSet(PENDING_MOVERS_KV, JSON.stringify(legacy));
      return legacy;
    } catch {
      /* corrupt legacy file — treat as none */
    }
  }
  return null;
}
function savePendingMovers(pm: PendingMovers): void {
  kvSet(PENDING_MOVERS_KV, JSON.stringify(pm));
}
function clearPendingMovers(): void {
  kvDel(PENDING_MOVERS_KV);
}


async function deliver(
  body: string,
  options: { dryRun?: boolean; webhookUrl?: string },
): Promise<void> {
  if (options.dryRun) {
    console.log("--- DRY RUN REVIEW ---\n" + body + "\n");
    return;
  }
  // Review output goes ONLY to stdout (relayed by the Discord assistant in this
  // thread) + the local dashboard ring buffer. NEVER posted to any channel.
  await appendAlertLog(body);
  console.log(body);
}

function pct(n?: number): string {
  return n == null ? "?" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}%`;
}

function moverLine(m: ClassifiedMover, index?: number): string {
  const tag =
    m.ladder ? "🪜" : m.noData ? "💀" : m.collapsed ? "📉" : m.kind === "alerted" ? "✅报过" : "🕳️";
  const prefix = index != null ? `${index}. ` : "  ";
  return (
    `${prefix}${tag} ${m.symbol ?? m.address.slice(0, 10)} [${m.chain}] +${m.priceChange24h.toFixed(0)}% ` +
    `vol $${(m.volume24hUsd / 1e6).toFixed(1)}M liq $${(m.liquidityUsd / 1e3).toFixed(0)}K` +
    (m.fdvUsd ? ` mcap $${(m.fdvUsd / 1e6).toFixed(1)}M` : "") +
    `\n` +
    `   \`${m.address}\`` +
    (m.newsNote ? `\n   📰 ${m.newsNote}` : "")
  );
}

export interface DailyReviewResult {
  graded: LabeledOutcome[];
  movers: ClassifiedMover[];
  candidates: ClassifiedMover[];
  report: string;
}

/**
 * Phase 1 (automated, every 24h): grade our own alerts, scan for 暴涨,
 * auto-filter, then post a numbered candidate checklist for HUMAN
 * confirmation. Tuning/analysis waits for confirmMovers().
 */
export async function runDailyReview(options: {
  dryRun?: boolean;
  webhookUrl?: string;
} = {}): Promise<DailyReviewResult> {
  console.log("daily review: grading outcomes…");
  // Robinhood tokenized stocks (QQQ/MU/…) and spam tokens with junk symbols
  // pollute the meme review — drop them from grading and candidates entirely.
  const stockReg = await fetchStockRegistry().catch(() => undefined);
  // Stock-ticker tokens are noise on EVERY chain — robinhood tokenized stocks
  // (QQQ/MU) and solana stock-name memes (COIN/AAPL/NVDA/GOOGL/META/AMZN…).
  const isStock = (r: { chain?: string; symbol?: string }): boolean =>
    !!r.symbol && !!stockReg?.symbols.has(r.symbol.toUpperCase());
  const isMalformed = (r: { symbol?: string }): boolean =>
    (r.symbol?.length ?? 0) > 40;
  const graded = await gradePendingOutcomes({
    drop: (r) => isStock(r) || isMalformed(r),
  });

  console.log("daily review: scanning movers…");
  const state = await loadMonitorState();
  const ledger = [...(await loadLabeledOutcomes()), ...(await loadPendingOutcomes())];
  const movers = await scanMissedMovers(enabledChains(), state, ledger);

  // 过滤日志（本地留痕，非频道）: record every judgment of the day,
  // kept and filtered alike — the filter-log Discord channel was removed.
  await appendFilterJournal("Phase 1 暴涨扫描", movers).catch((err) =>
    console.error("filter journal failed:", (err as Error).message),
  );

  // Real-fdv guard: DexPaprika volume-sort can hand us a JUNK-quote pool (e.g.
  // memestock/utility vs GMEB) whose inflated fdv ($178M) defeats the mcap gate
  // while the real trusted-quote pool says $1.5M. Re-resolve fdv from the token's
  // trusted-quote pool for every mover that could still become a candidate.
  try {
    const { fetchTokenPairs } = await import("../dex/dexscreener.js");
    const { selectDeepestBasePair } = await import("../chains/generic-analysis.js");
    for (const m of movers) {
      if (m.kind === "alerted" || m.ladder || m.noData || m.safetyFlags?.length) continue;
      if (isStock(m) || isMalformed(m)) continue;
      try {
        const real = selectDeepestBasePair(await fetchTokenPairs(m.address, m.chain), m.address);
        const rf = Number(real?.fdv ?? 0);
        if (rf > 0) m.fdvUsd = rf;
      } catch {}
    }
  } catch (err) {
    console.error("real-fdv guard failed (continuing):", (err as Error).message);
  }

  // Already-reviewed misses (in the case library) must NOT resurface as
  // candidates. The human confirmed/processed them once (case + find2 + ★B);
  // re-presenting the same coin every hour is noise. User 2026-09-05:
  // 「做过的就不用再提醒我了，这里就是需要复盘那些没警报的或者还没复盘的」.
  const reviewed = new Set(
    (await loadMissedCases()).map((c) => `${c.chain}:${c.address.toLowerCase()}`),
  );

  // Coins we actually TRADED (open or closed) are NOT misses — classifyMover
  // only checks the alert ledger, so a bought coin whose ledger row aged out of
  // the 36h window resurfaced as a 🕳️ candidate. FATCOIN (2 trades) and SHROOM
  // (still open) both got mis-flagged 2026-09-05. Treat any position as capture.
  const traded = new Set(
    (await loadPositions()).positions.map(
      (p) => `${p.chain ?? "robinhood"}:${p.token.toLowerCase()}`,
    ),
  );

  // Candidates = misses that survived ALL automatic filters (incl. 市值≥$10M)
  // and are not already in the case library.
  const candidates = movers.filter(
    (m) =>
      m.kind !== "alerted" &&
      !m.ladder &&
      !m.noData &&
      !m.safetyFlags?.length &&
      !isStock(m) &&
      !isMalformed(m) &&
      !reviewed.has(`${m.chain}:${m.address.toLowerCase()}`) &&
      !traded.has(`${m.chain}:${m.address.toLowerCase()}`) &&
      (m.fdvUsd == null || m.fdvUsd >= MOVER_MIN_FDV_USD),
  );

  // BlockBeats 对照：漏掉的暴涨在律动上搜一把 — 报道过 = 新闻通道也漏了，
  // 说明过滤规则要修（2026-09-02: microduck 有 10 条报道，早于扫描 10 小时）
  try {
    const { searchNews } = await import("../news/blockbeats.js");
    for (const m of candidates) {
      if (!m.symbol) continue;
      const hits = await searchNews(m.symbol, 3);
      if (hits?.length) {
        m.newsNote = `律动 ${hits.length}+ 条报道，最新: ${hits[0].title}（${hits[0].createTime}）`;
      }
    }
  } catch (err) {
    console.error("news cross-check failed (continuing):", (err as Error).message);
  }
  // Merge with prior un-confirmed candidates so a mover the user hasn't yet
  // confirmed/excluded SURVIVES across later scans where it no longer
  // re-triggers. Without this, every 0-candidate (or different-candidate) scan
  // blindly overwrote the file and silently dropped the pending list — ZCAT
  // 2026-09-05 sat un-confirmed ~6 rounds, got wiped, and Phase 2 confirmed 0.
  // Fresh scan wins on dup (newest price/mcap); confirmMovers() rm's the file,
  // so entries clear the moment the user confirms or excludes them.
  const prior = loadPendingMovers()?.movers ?? [];
  const seen = new Set(candidates.map((m) => `${m.chain}:${m.address.toLowerCase()}`));
  for (const p of prior) {
    const key = `${p.chain}:${p.address.toLowerCase()}`;
    // Skip anything already reviewed (case library) or since traded — a prior
    // pending entry the user confirmed / we bought shouldn't linger.
    if (!seen.has(key) && !reviewed.has(key) && !traded.has(key)) {
      candidates.push(p);
      seen.add(key);
    }
  }
  savePendingMovers({ createdAt: new Date().toISOString(), movers: candidates });

  const wins = graded.filter((g) => g.outcome === "win");
  const losses = graded.filter((g) => g.outcome === "loss");
  const filtered = movers.filter(
    (m) => m.ladder || m.noData || m.safetyFlags?.length,
  );
  const lowMcap = movers.filter(
    (m) =>
      m.kind !== "alerted" &&
      !m.ladder &&
      !m.noData &&
      !m.safetyFlags?.length &&
      m.fdvUsd != null &&
      m.fdvUsd < MOVER_MIN_FDV_USD,
  );

  const lines = [
    `📊 **每日复盘 Phase 1** — ${new Date().toISOString().slice(0, 10)}`,
  ];
  if (graded.length) {
    lines.push(
      `我们的警报: ${graded.length} 个已评分 — ✅ ${wins.length} 赢 ⚪ ${graded.length - wins.length - losses.length} 平 ❌ ${losses.length} 假警报`,
    );
    for (const w of wins.slice(0, 3)) {
      lines.push(`  ✅ ${w.symbol} [${w.chain}] ${pct(w.maxReturn)}`);
    }
  }
  if (filtered.length) {
    lines.push(
      `已自动过滤 ${filtered.length} 个 (🪜刷单/💀无数据): ${filtered.slice(0, 6).map((m) => m.symbol ?? "?").join(", ")}`,
    );
  }
  if (lowMcap.length) {
    lines.push(
      `已按当前市值<$${(MOVER_MIN_FDV_USD / 1e6).toFixed(0)}M 过滤 ${lowMcap.length} 个: ${lowMcap.slice(0, 6).map((m) => m.symbol ?? "?").join(", ")}`,
    );
  }
  // 自我出场复盘: 卖飞的仓位 + 报了没买的暴涨 (NUDES/FATCOIN 教训 — 复盘
  // 必须盯自己的单, 不只盯警报质量)。失败不挡 Phase 1。
  let ownReview: OwnTradeReview = { soldTooEarly: [], neverBought: [], lines: [] };
  try {
    ownReview = await reviewOwnTrades(movers);
  } catch (err) {
    console.error("own-trade review failed (continuing):", (err as Error).message);
  }
  lines.push(...ownReview.lines);

  if (candidates.length) {
    lines.push("", "**⏸️ 待确认的暴涨候选清单 — 请审核:**");
    candidates.forEach((m, i) => lines.push(moverLine(m, i + 1)));
    lines.push(
      "",
      "确认: `/review-confirm` (全部通过) 或 `/review-confirm exclude:1,3` (剔除编号)",
      "CLI: `npm run review:confirm [-- --exclude=1,3]`",
      "确认后才会进入案例库、调参和回测。",
    );
  } else {
    lines.push("今日无需确认的暴涨候选。");
  }

  const report = lines.join("\n");
  await deliver(report, options);

  await appendReviewJournal(
    [
      journalHeader("Phase 1 — 扫描"),
      `- 警报评分: ${graded.length} (赢 ${wins.length} / 假 ${losses.length})`,
      ...wins.map((w) => `  - ✅ ${w.symbol} [${w.chain}] ${pct(w.maxReturn)} triggers=${w.triggers.join(",")}`),
      ...losses.map((l) => `  - ❌ ${l.symbol} [${l.chain}] ${pct(l.minReturn)} triggers=${l.triggers.join(",")}`),
      `- 暴涨扫描: ${movers.length} 个, 自动过滤 ${filtered.length} 个, 待人工确认 ${candidates.length} 个`,
      `- 自我出场复盘: 卖飞 ${ownReview.soldTooEarly.length} 个, 报了没买 ${ownReview.neverBought.length} 个`,
      ...ownReview.soldTooEarly.map(
        (s) => `  - 🏃 ${s.symbol} [${s.chain}] ${s.multiple.toFixed(1)}x 出场机制=${s.exitReasons.join(",")}`,
      ),
      ...ownReview.neverBought.map(
        (n) => `  - 🚫 ${n.symbol} [${n.chain}] +${n.priceChange24h.toFixed(0)}%`,
      ),
      ...candidates.map(
        (m, i) =>
          `  - ${i + 1}. ${m.symbol} [${m.chain}] +${m.priceChange24h.toFixed(0)}% ${m.kind} \`${m.address}\`${m.newsNote ? `\n    📰 ${m.newsNote}` : ""}`,
      ),
    ].join("\n"),
  );

  return { graded, movers, candidates, report };
}

export interface ConfirmResult {
  confirmed: ClassifiedMover[];
  excluded: ClassifiedMover[];
  tune: TuneResult;
  narrative?: string;
  report: string;
  pushed: boolean;
}

/**
 * Phase 2 (after human confirmation): excluded → permanent denylist;
 * confirmed → miss cases; then case library + tuner + backtest + journal.
 */
export async function confirmMovers(
  excludeIndices: number[] = [],
  options: { dryRun?: boolean; webhookUrl?: string } = {},
): Promise<ConfirmResult | { error: string }> {
  const pending = loadPendingMovers();
  if (!pending) {
    return { error: "没有待确认的清单 — 先跑 npm run review" };
  }

  const excluded: ClassifiedMover[] = [];
  const confirmed: ClassifiedMover[] = [];
  pending.movers.forEach((m, i) => {
    if (excludeIndices.includes(i + 1)) excluded.push(m);
    else confirmed.push(m);
  });

  if (excluded.length) {
    await addToDenylist(
      excluded.map((m) => ({
        chain: m.chain,
        address: m.address,
        symbol: m.symbol,
        reason: "user review exclusion",
      })),
    );
  }
  if (confirmed.length) await saveMissedCases(confirmed);
  clearPendingMovers();
  await appendFilterDecisions(confirmed, excluded).catch((err) =>
    console.error("filter journal failed:", (err as Error).message),
  );

  console.log("confirm: building case library + tuning…");
  const library = await buildCaseLibrary(
    await loadLabeledOutcomes(),
    await loadMissedCases(),
  );
  const tune = await tuneSignalConfig(library);
  const narrative = await analyzeDailyReview({
    graded: await loadLabeledOutcomes(),
    movers: confirmed,
    tune,
  });

  const lines = [
    `📊 **每日复盘 Phase 2** — 已确认`,
    `确认 ${confirmed.length} 个进入案例库${excluded.length ? `, 剔除 ${excluded.length} 个进黑名单 (${excluded.map((m) => m.symbol).join(", ")})` : ""}`,
    tune.adopted
      ? `🔧 调参已采纳: ${JSON.stringify(tune.changes)} — ${tune.reason}`
      : `🔧 调参: 无变更 — ${tune.reason}`,
  ];
  if (narrative) lines.push("", narrative);
  const report = lines.join("\n");
  await deliver(report, options);

  await appendReviewJournal(
    [
      journalHeader("Phase 2 — 确认与调参"),
      `- 确认 ${confirmed.length}: ${confirmed.map((m) => `${m.symbol}[${m.chain}]`).join(", ") || "无"}`,
      `- 剔除进黑名单 ${excluded.length}: ${excluded.map((m) => `${m.symbol}[${m.chain}] \`${m.address}\``).join(", ") || "无"}`,
      `- 案例库: ${library.length} 个案例`,
      `- 调参: ${tune.adopted ? `采纳 ${JSON.stringify(tune.changes)}` : "无变更"} — ${tune.reason}`,
      tune.best
        ? `- 回测: 赢保持 ${tune.best.winsCaptured}, 漏捕 ${tune.current.missesCaptured}→${tune.best.missesCaptured}, 假警报 ${tune.current.falseAlerts}→${tune.best.falseAlerts}, 基础fixtures全过`
        : `- 回测: 当前配置 赢${tune.current.winsCaptured} 漏${tune.current.missesCaptured} 假${tune.current.falseAlerts}`,
      narrative ? `- 分析: ${narrative.split("\n")[0]}…` : "",
    ].join("\n"),
  );

  await writeFile(
    REVIEW_WEB_PATH,
    JSON.stringify(
      {
        meta: { updated_at: new Date().toISOString() },
        confirmed,
        excluded,
        tune: { adopted: tune.adopted, reason: tune.reason, changes: tune.changes },
        narrative,
      },
      null,
      2,
    ),
    "utf8",
  ).catch(() => {});

  const pushed = options.dryRun ? false : await autoPush(tune);
  return { confirmed, excluded, tune, narrative, report, pushed };
}

/**
 * Auto-push removed: review learning (outcomes, denylist, journals, tuner
 * overrides) now lives in SQLite, and personalized state must not be committed
 * to a public repo. The DB is backed up out-of-band (litestream / snapshot),
 * not via git. Kept as a no-op so callers/telemetry are unchanged.
 */
async function autoPush(_tune: TuneResult): Promise<boolean> {
  return false;
}
