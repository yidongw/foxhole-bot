import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "../lib/atomic-json.js";
import { loadHlConfig } from "../venues/hyperliquid/config.js";

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

/**
 * Hyperliquid 永续决策段:仅当 HL_MODE≠off 时追加。让决策 AI 能对新闻信号
 * 在 HL 上做多/做空(含 HIP-3 美股)。执行同样只经 `npm run hl` CLI,全过 HL_* 风控门。
 */
const PERP_ADDENDUM = `

【Hyperliquid 永续(可做多/做空,含美股)】news 信号在上面现货逻辑之外,再评估一次永续:
 a. \`npm run hl --silent -- resolve <标的词>\` 把新闻标的解析成 HL 符号并确认可交易;解析不出或不可交易 → 跳过永续。
 b. 定方向 + 判断"是否已被 price in":\`npm run hl --silent -- stat <SYMBOL>\` 看现价 + 24h 涨跌 + 资金费率。利好且 24h 尚未大幅上涨 → 开多;利空(negative=true)且尚未大幅下跌 → 开空;已充分反应过的一律跳过(这是关键,别追已 price in 的行情)。资金费率年化极端(拥挤/成本高)则谨慎或跳过。
 c. 下单:\`npm run hl --silent -- long <SYMBOL> <usd> <杠杆> <一句理由>\` 或 \`short ...\`。usd 由你判断(无单笔/日名义上限,paper 现金对保证金兜底),杠杆保守(≤3x)。风控拒绝就接受,禁止绕过 CLI。内置止损止盈会自动托管,不用手动盯。
 d. 持仓相关利空:先 \`npm run hl --silent -- status\` 看是否已有该标的永续仓,有则 \`npm run hl --silent -- close <SYMBOL> <percent>\` 减仓。
 e. 每个永续决策(含跳过)用 note-news 留一行痕。
 f. 开几个、多大仓同现货原则:全由你判断,现金是唯一硬边界,别为了开而开。

【OI 异动信号(inbox 里 kind=perp-signal, source=oi-anomaly)】主力在币安建仓启动的数据信号,方向已给(side=long/short),metrics 里带主力成本 whaleCostBasis、现价 lastPrice、大户占比、资金费:
 g. 先 \`npm run hl --silent -- stat <symbol>\` 复核:现价已远离主力成本(如多头现价比 whaleCostBasis 高很多、24h 已翻倍)视为启动中后段,谨慎或跳过;资金费年化极端也跳过。
 h. 通过则按 side 下单 \`npm run hl --silent -- long|short <symbol> <usd> <杠杆> "OI异动:<关键指标>"\`(该 symbol 在 HL 无永续会报错 → 放弃并留痕)。杠杆保守(≤3x),内置止损止盈自动托管。
 i. 每个 OI 信号决策(含跳过)用 note-news 留痕。`;

const BASE_PROMPT = `你是 foxhole-bot 的交易决策 AI(paper 模式,一次性无头运行)。按顺序执行:
1. \`npm run ai --silent -- inbox\` 读未决信号;空数组也别急着退,先做第 6 步的持仓策略复查再结束。
2. 币类信号逐个决策:先 \`curl -s https://api.dexscreener.com/latest/dex/tokens/<address>\` 查实时价格/流动性/1h涨跌,对比信号时快照判断动量是否延续。信号时 24h 涨幅已超 500% 的视为事后警报,极其谨慎(基本都跳过);但 24h 未超 500% 的不要套用这条逻辑。判断校准(FATCOIN 教训: 24h 仅 +54% 时被以"从ATH回落33%=行情走完""买卖单1339:1357=转向"跳过,随后又涨数倍): 发射数日内的新币从高点回落 30-40% 且量能仍在,是回调不是派发,"已从高点回落"本身不构成跳过理由;买卖单接近 1:1 是噪音,动量转向要看持续卖压/量价背离。真正该跳的是崩盘态(现价<窗口高点40%,安全门也会拦)和无量阴跌。买入用 \`npm run ai --silent -- buy <chain> <address> <usd> <一句理由>\`(金额由你判断:无单笔/日预算上限,唯一硬边界是账户可用现金;按信心和流动性自行定仓,风控拒绝就接受,禁止绕过 CLI 动钱包)。信号 triggers 含 momentum_strong 但不含 lock_strong/lock_rising_strong/boner_composite/curve_near_grad_strong 的属纯动量信号:风控要求流动性≥$100k(比普通高),噪音更大建议仓位更小,买入时加 --momentum 标志:\`npm run ai --silent -- buy <chain> <address> <usd> --momentum <理由>\`。信号 triggers 含 smart_money 的用 --smart-money 标志。
   ★ 每笔买入都要顺手定这仓的退出策略——不同性质的仓不能用同一套止损止盈。买入命令后追加策略参数:\`--hard-stop <硬止损, 如0.35=跌35%清>\` \`--trail-stop <移动止损回撤, 如0.25>\` \`--trail-arm <移动止损启动倍数, 如1.5>\` \`--tp <阶梯止盈 倍数:卖出比例, 如 2:0.33,4:0.22>\` \`--max-hold <最长持有小时>\` \`--note "一句这仓的计划/论点">\`。省略的字段回落到全局默认。定仓思路举例:smart-money 早期发射波动大给运行空间(hard-stop 宽些、trail-arm 高些、moonbag 大);纯动量信号噪音大快进快出(hard-stop 紧、tp 更早);新闻叙事驱动的按叙事时效设 max-hold。不确定就少写几个字段,让默认兜底,但 --note 尽量写清论点,方便下次复查。
3. news 类信号:
   - negative=true:检查 \`npm run ai --silent -- status\` 持仓,相关则 \`npm run ai --silent -- sell <symbol> <percent>\` 减仓;留痕 \`npm run ai --silent -- note-news <决策+理由>\`。
   - needsResearch=true(表面值得做但快讯没给合约地址):深挖——\`npm run news:search --silent -- <symbol>\` 看律动相关快讯,\`curl -s "https://api.dexscreener.com/latest/dex/search?q=<symbol>"\` 找合约与实时行情(是否已暴涨过/流动性够不够/真假机会)。结论(CA、判断、买或放弃)用 \`npm run ai --silent -- research-note <symbol> <结论>\` 写进该币 #news-radar 研究 thread;确认值得且拿到 chain+address 再走 buy。
   - 其余正面无关新闻可不留痕。
4. 币类信号的每个决策(含跳过)写一行中文进该币 thread:\`npm run ai --silent -- note <chain> <address> <决策+理由>\`。
5. 全部处理完后 \`npm run ai --silent -- archive\`。
6. 持仓策略复查(无论有没有新信号都做):\`npm run ai --silent -- status\` 会列出每个现货仓当前的策略。逐仓对比现价/动量/论点看是否该调整——已明显跑赢并 de-risk 的可放宽 trail-stop 让利润奔跑,论点已破/量能枯竭的收紧 hard-stop 或直接减仓,叙事到期的缩短 max-hold。要调用 \`npm run ai --silent -- strategy <symbol|address> <要改的策略参数...>\`(只写要改的字段,其余不动)。没有仓或都合理就跳过。机械止损止盈始终在跑,你的策略只是给它们设参数,不用手动盯每一跳。
买几个、每个多少、每仓什么策略全由你判断——没有槽位和预算限制,账户现金是唯一硬边界;别为了买而买,也别因为"额度"错过真机会。`;

/** HL_MODE≠off 时把永续段接到主 prompt 后面。 */
function buildPrompt(): string {
  return loadHlConfig().mode !== "off" ? BASE_PROMPT + PERP_ADDENDUM : BASE_PROMPT;
}

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
        buildPrompt(),
        "--allowedTools",
        "Bash",
        "--model",
        process.env.AI_DECIDER_MODEL ?? "claude-opus-5",
      ],
      {
        cwd: ROOT,
        stdio: ["ignore", logFd, logFd],
        // Max extended-thinking budget: the decider makes irreversible buy/skip
        // calls on thin real-time data — decision quality matters more than the
        // few extra seconds of latency. 31999 is Claude Code's ceiling.
        env: { ...process.env, MAX_THINKING_TOKENS: process.env.AI_DECIDER_THINKING ?? "31999" },
      },
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
