import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDb, transaction } from "../lib/db.js";
import { resolveWebhook } from "../notify/routes.js";
import { sendDiscordMessage } from "../notify/discord.js";

/**
 * Execution-failure capture + self-heal dispatch. When a trade can't fill (e.g.
 * both RB routes fail: LI.FI reverts AND hoodchain NoRouteError on a Uniswap-v4
 * -only pool), the failure is classified and recorded, an alert fires, and —
 * for STRUCTURAL gaps (a routing capability the code lacks) — a headless repair
 * agent can be dispatched. Division of labour:
 *   • executor  → real-time rescue (walk the venue chain) + classify.
 *   • transient → retried by the executor / next tick; no agent.
 *   • structural→ needs code (add a v4 route) → a repair agent (this file),
 *                 mirroring the decider: a fresh `claude -p`, but with edit/git
 *                 tools; it fixes on a worktree + opens a PR (never deploys).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const LOCK = path.join(ROOT, "data", "repair.lock");
const LOG_DIR = path.join(ROOT, "data", "repair-logs");
const LOCK_STALE_MS = 30 * 60_000;
const CHILD_TIMEOUT_MS = 20 * 60_000;
/** Don't re-dispatch a repair for the same signature within this window. */
const DEDUP_MS = 6 * 60 * 60_000;

export type FailureKind = "transient" | "structural" | "unknown";

export interface ExecFailure {
  chain: string;
  token: string;
  symbol?: string;
  pool?: string;
  /** The combined error text from the venue chain. */
  reason: string;
}

/** Classify a failure from its error text. Structural = a routing/capability
 *  gap the code must fix; transient = retryable external hiccup. */
export function classifyFailure(reason: string): FailureKind {
  const r = reason.toLowerCase();
  if (/no.?route|noroute|no aggregator route|unsupported|v4|not covered|无路由/.test(r)) {
    return "structural";
  }
  if (/429|rate.?limit|timeout|etimedout|econn|socket|502|503|nonce|slippage|临时|重试/.test(r)) {
    return "transient";
  }
  return "unknown";
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a fill failure (classify + persist + alert), and for structural gaps
 * dispatch a repair agent. Never throws — capturing a failure must not mask it.
 */
export async function recordExecFailure(f: ExecFailure): Promise<void> {
  try {
    const kind = classifyFailure(f.reason);
    const signature = `${kind}:${f.chain}:${f.reason.slice(0, 60)}`;
    await transaction((db) => {
      db.prepare(
        `INSERT INTO exec_failures (at, chain, token, symbol, pool, kind, signature, reason, repair_status)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        new Date().toISOString(),
        f.chain,
        f.token.toLowerCase(),
        f.symbol ?? null,
        f.pool ?? null,
        kind,
        signature,
        f.reason.slice(0, 400),
        null,
      );
    });

    const url = resolveWebhook("trade", f.chain);
    if (url) {
      await sendDiscordMessage(
        url,
        `❌ **成交失败** ${f.symbol ?? f.token.slice(0, 8)} [${f.chain}] (${kind})\n${f.reason.slice(0, 300)}` +
          (kind === "structural" ? "\n→ 结构性路由缺口,尝试派维修工" : kind === "transient" ? "\n→ 临时故障,下轮重试" : ""),
      ).catch(() => {});
    }

    // NOTE: we only RECORD here. Dispatching the repair agent is the long-lived
    // monitor's job (dispatchPendingRepairs) — spawning a 20-min agent from this
    // short-lived `ai-trade buy` process would die with it (the same "probes die
    // with their session" trap the decider avoids by letting the monitor own the
    // wake). The decider gets its failure message back immediately and moves on.
  } catch (err) {
    console.error("recordExecFailure failed:", (err as Error).message);
  }
}

function repairRecentlyDispatched(signature: string): boolean {
  try {
    const cutoff = new Date(Date.now() - DEDUP_MS).toISOString();
    const row = getDb()
      .prepare(
        "SELECT 1 FROM exec_failures WHERE signature=? AND at>=? AND repair_status IS NOT NULL LIMIT 1",
      )
      .get(signature, cutoff);
    return !!row;
  } catch {
    return false;
  }
}

function repairRunning(): boolean {
  try {
    const lock = JSON.parse(readFileSync(LOCK, "utf8")) as { pid: number; at: string };
    if (Date.now() - new Date(lock.at).getTime() < LOCK_STALE_MS && pidAlive(lock.pid)) return true;
    rmSync(LOCK, { force: true });
    return false;
  } catch {
    return false;
  }
}

function resolveClaudeBin(): string | undefined {
  if (process.env.AI_DECIDER_BIN) return process.env.AI_DECIDER_BIN;
  for (const c of [
    path.join(homedir(), ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ]) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

function repairPrompt(f: ExecFailure): string {
  return `你是 foxhole-bot 的**维修工 agent**(一次性无头)。一笔实盘交易执行失败,疑似**结构性路由缺口**:
链: ${f.chain} · 标的: ${f.symbol ?? ""} ${f.token} · 池: ${f.pool ?? "?"}
失败原因(各 venue 合并): ${f.reason}

任务(只修代码,绝不碰钱/持仓/部署):
1. 先判定是不是真的结构性缺口(比如该池是 Uniswap v4-only,而已配置的路由器只覆盖 v3/聚合器无 v4 路由)。若其实是临时/外部故障,把判断写清后结束,别乱改。
2. 若确是路由缺口:在**独立 git worktree + 新分支**里(参考 scripts/deploy.sh / 现有 worktree 约定,别在主 checkout 改),给 src/venues 或 src/trade/execute.ts 补一条能覆盖该池型的路由(如接入/启用一个支持 v4 的聚合器,或补 v4 路由参数)。
3. 跑 \`npm run typecheck\` 和 \`npm test\`,全绿才行。
4. \`gh pr create\` 开一个 PR 说明缺口 + 修法 + 该失败案例。**不要合并、不要部署、不要动 main。**
5. 只碰路由/venue 代码,绝不改 positions/风控/decider 逻辑。
6. **全程向用户汇报**(否则你就是个黑箱):用 \`npm run ai --silent -- note-news "🔧 维修工: <消息>"\` 至少发三次——(a)上线时报一句诊断结论;(b)开完 PR 报 PR 链接;(c)判定为临时/不该修时报原因并结束。`;
}

/**
 * The long-lived monitor calls this (a slow loop): scan for an undispatched
 * structural failure and spawn ONE repair agent for it. Owning the spawn here —
 * not in the short-lived executor — gives the agent a proper (detached) lifecycle
 * and a single, rate-limited dispatch point (mirrors "the monitor owns the
 * decider wake"). Off by default (AI_REPAIR=1). PR-only, one at a time, deduped.
 */
export async function dispatchPendingRepairs(): Promise<boolean> {
  if (process.env.AI_REPAIR !== "1") return false;
  const bin = resolveClaudeBin();
  if (!bin) return false;
  try {
    if (repairRunning()) return false;
    const cutoff = new Date(Date.now() - DEDUP_MS).toISOString();
    const row = getDb()
      .prepare(
        `SELECT id, chain, token, symbol, pool, signature, reason FROM exec_failures
         WHERE kind='structural' AND repair_status IS NULL AND at>=?
         ORDER BY at DESC LIMIT 1`,
      )
      .get(cutoff) as
      | { id: number; chain: string; token: string; symbol: string | null; pool: string | null; signature: string; reason: string }
      | undefined;
    if (!row) return false;
    if (repairRecentlyDispatched(row.signature)) {
      // Another failure with this signature already dispatched — mark skipped.
      getDb().prepare("UPDATE exec_failures SET repair_status='skipped' WHERE id=?").run(row.id);
      return false;
    }

    mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const logFd = openSync(path.join(LOG_DIR, `${stamp}-repair.log`), "a");
    const f: ExecFailure = {
      chain: row.chain,
      token: row.token,
      symbol: row.symbol ?? undefined,
      pool: row.pool ?? undefined,
      reason: row.reason,
    };
    const child = spawn(
      bin,
      ["-p", repairPrompt(f), "--allowedTools", "Edit Bash Read Write", "--model", process.env.AI_REPAIR_MODEL ?? "claude-opus-5"],
      // detached + unref: the agent outlives this monitor tick.
      { cwd: ROOT, stdio: ["ignore", logFd, logFd], env: { ...process.env }, detached: true },
    );
    child.unref();
    writeFileSync(LOCK, JSON.stringify({ pid: child.pid ?? 0, at: new Date().toISOString() }));
    getDb().prepare("UPDATE exec_failures SET repair_status='dispatched' WHERE id=?").run(row.id);
    // Make the dispatch visible — a silent headless agent is a black box.
    const url = resolveWebhook("trade", row.chain);
    if (url) {
      await sendDiscordMessage(
        url,
        `🔧 **派维修工**(结构性路由缺口)${row.symbol ?? row.token.slice(0, 8)} [${row.chain}]\n${row.reason.slice(0, 240)}\n→ 无头 agent 上线:诊断→改路由→跑测试→开 PR(不部署)。进度看 #news-radar。`,
      ).catch(() => {});
    }
    const killer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
    killer.unref();
    child.on("exit", (code) => {
      clearTimeout(killer);
      rmSync(LOCK, { force: true });
      console.log(`repair agent exited ${code}`);
    });
    child.on("error", () => rmSync(LOCK, { force: true }));
    console.log(`repair agent spawned pid ${child.pid} for ${row.signature}`);
    return true;
  } catch (err) {
    console.error("repair dispatch error:", (err as Error).message);
    return false;
  }
}
