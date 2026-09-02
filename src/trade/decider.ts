import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "../lib/atomic-json.js";

/**
 * Headless AI decider — spawned by the monitor the moment a trade signal
 * (or news wake) lands in the ai-inbox.
 *
 * Why: the original design relied on a background probe armed inside a
 * Discord Claude session to watch ai-inbox.jsonl. Probes die when their
 * session ends, so signals delivered between sessions got no decision at
 * all (the DIDDY lesson: signal 17:47, first look 3h later, token -70%).
 * The monitor is the long-lived process — it owns the wake now.
 *
 * The child is a fresh `claude -p` run in the repo root; it can only act
 * through the ai-trade CLI (full risk + safety gates, $50 clamp), so the
 * blast radius of a bad decision is the same as any AI patrol session.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const LOCK_PATH = path.join(ROOT, "data", "decider.lock");
const LOG_DIR = path.join(ROOT, "data", "decider-logs");

/** One decider at a time; a lock older than this is presumed crashed. */
const LOCK_STALE_MS = 10 * 60_000;
/** Hard kill — a decision run should take a couple of minutes at most. */
const CHILD_TIMEOUT_MS = 8 * 60_000;

const PROMPT = `你是 foxhole-bot 的交易决策 AI(paper 模式,一次性无头运行)。按顺序执行:
1. \`npm run ai --silent -- inbox\` 读未决信号;空数组则直接结束。
2. 币类信号逐个决策:先 \`curl -s https://api.dexscreener.com/latest/dex/tokens/<address>\` 查实时价格/流动性/1h涨跌,对比信号时快照判断动量是否延续。信号时 24h 涨幅已超 500% 的视为事后警报,极其谨慎(基本都跳过)。买入用 \`npm run ai --silent -- buy <chain> <address> <usd> <一句理由>\`(≤50,风控拒绝就接受,禁止绕过 CLI 动钱包)。
3. news 类信号:negative=true 时检查 \`npm run ai --silent -- status\` 的持仓,若相关则 \`npm run ai --silent -- sell <symbol> <percent>\` 减仓。
4. 每个决策(含跳过)写一行中文进该币 thread:\`npm run ai --silent -- note <chain> <address> <决策+理由>\`。
5. 全部处理完后 \`npm run ai --silent -- archive\`。
注意总预算:同一个 tick 多个信号也最多买 1-2 个最好的,不要全买。`;

interface LockFile {
  pid: number;
  at: string;
}

function resolveClaudeBin(): string | undefined {
  if (process.env.AI_DECIDER_BIN) return process.env.AI_DECIDER_BIN;
  // launchd PATH is trimmed (/opt/homebrew/bin:/usr/bin:/bin) — the CLI
  // usually lives in ~/.local/bin, so probe known locations first.
  for (const candidate of [
    path.join(homedir(), ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function lockHeld(): Promise<boolean> {
  try {
    const lock = JSON.parse(await readFile(LOCK_PATH, "utf8")) as LockFile;
    return (
      Date.now() - new Date(lock.at).getTime() < LOCK_STALE_MS &&
      pidAlive(lock.pid)
    );
  } catch {
    return false;
  }
}

/**
 * Spawn a decider run unless one is already working the inbox. Returns
 * true when a child was actually started. Never throws — a failed wake
 * must not break the monitor tick (the hourly patrol remains the backstop).
 */
export async function maybeSpawnDecider(trigger: string): Promise<boolean> {
  if (process.env.AI_DECIDER === "0") return false;
  const bin = resolveClaudeBin();
  if (!bin) return false;

  try {
    if (await lockHeld()) return false;

    mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const logFd = openSync(path.join(LOG_DIR, `${stamp}-${trigger}.log`), "a");

    const child = spawn(
      bin,
      [
        "-p",
        PROMPT,
        "--allowedTools",
        "Bash",
        "--model",
        process.env.AI_DECIDER_MODEL ?? "claude-opus-5",
      ],
      { cwd: ROOT, stdio: ["ignore", logFd, logFd] },
    );
    await writeJsonAtomic(LOCK_PATH, {
      pid: child.pid ?? 0,
      at: new Date().toISOString(),
    } satisfies LockFile);

    const killer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
    killer.unref();
    child.on("exit", (code) => {
      clearTimeout(killer);
      closeSync(logFd);
      void rm(LOCK_PATH, { force: true });
      console.log(`decider[${trigger}] exited ${code}`);
    });
    child.on("error", (err) => {
      closeSync(logFd);
      void rm(LOCK_PATH, { force: true });
      console.error(`decider[${trigger}] spawn failed:`, err.message);
    });
    console.log(`decider[${trigger}] spawned pid ${child.pid}`);
    return true;
  } catch (err) {
    console.error("decider spawn error:", (err as Error).message);
    return false;
  }
}
