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
2. 币类信号逐个决策:先 \`curl -s https://api.dexscreener.com/latest/dex/tokens/<address>\` 查实时价格/流动性/1h涨跌,对比信号时快照判断动量是否延续。信号时 24h 涨幅已超 500% 的视为事后警报,谨慎——但先分清是哪种 500%,别一刀切跳过:①成熟池(创建>24h)真涨了 5 倍=确实追晚,基本跳过;②新发射池(创建<24h,尤其<12h)的"24h +600倍/+62940%"是近零基数的数学假象,不代表"已涨完追晚",而是价格发现期——别用 24h 绝对涨幅判死刑,改看短窗(m5/h1 价格是否还在走、流动性是否在增厚、买卖单),用 pairCreatedAt 核实池龄。对②这类新发射+热叙事(尤其同一时段多个同题材币连发的"币股Meme"这种活跃板块),只要不是明确净卖压(买卖单<0.8 且 m5/h1 转负)或无量阴跌,默认做小额试探仓(小金额+紧硬止损+早启trail+短max-hold)而不是整单放弃——这类板块反复产出跳过后仍 +3x 的续涨,半数派发也是 +EV,VOXEL(+230倍事后警报)就是这么做对的,而 MEME/币股Meme 同样形态却被整单跳过后 $13M→$47M(+3x),是这条门槛的系统性误伤。校准要点:买卖单 0.9–1.1 在垂直拉升中是换手噪音不是派发,别据此扣"净卖压";单个同题材前车(如 CINEMA 砸盘)是轶事不是本币判据。整单跳过只留给:成熟池确认追晚、明确持续净卖压+量价背离、崩盘态(现价<窗口高点40%,安全门也会拦)、无量阴跌。判断校准(FATCOIN 教训: 24h 仅 +54% 时被以"从ATH回落33%=行情走完""买卖单1339:1357=转向"跳过,随后又涨数倍): 发射数日内的新币从高点回落 30-40% 且量能仍在,是回调不是派发,"已从高点回落"本身不构成跳过理由;买卖单接近 1:1 是噪音,动量转向要看持续卖压/量价背离。真正该跳的是崩盘态(现价<窗口高点40%,安全门也会拦)和无量阴跌。★代币化真股票有锚,别当自由漂浮的meme炒(AMC教训 2026-09-04,同日两次误伤:@\$8.35=正股2.65的215%溢价被硬止损-35%,@\$4.02=52%溢价被迫撤退):data/rh-stock-registry.json 里的官方代币化美股(AMC/GME正股/AAPL等)可铸可赎,美股开盘(13:30 UTC,夏令时)做市商套利会把溢价压向正股价——买前必查正股实时价(WebSearch"<ticker> stock price premarket"),算溢价:溢价>20%别做多,持仓时限跨越美股开盘的要在开盘前收敛处理;溢价小或折价+叙事强才有不对称性。纯meme(MEME/币股meme仿盘)无锚不适用此条,该怎么炒怎么炒。没有做空工具(HL无股票永续已验证),高溢价的正确动作是不买/离场,不是硬扛。买入用 \`npm run ai --silent -- buy <chain> <address> <usd> <一句理由>\`(金额由你判断:无单笔/日预算上限,唯一硬边界是账户可用现金;按信心和流动性自行定仓,风控拒绝就接受,禁止绕过 CLI 动钱包)。信号 triggers 含 momentum_strong 但不含 lock_strong/lock_rising_strong/boner_composite/curve_near_grad_strong 的属纯动量信号:风控要求流动性≥$100k(比普通高),噪音更大建议仓位更小,买入时加 --momentum 标志:\`npm run ai --silent -- buy <chain> <address> <usd> --momentum <理由>\`。信号 triggers 含 smart_money 的用 --smart-money 标志。
   ★ 每笔买入都要顺手定这仓的退出策略——不同性质的仓不能用同一套止损止盈。买入命令后追加策略参数:\`--hard-stop <硬止损, 如0.35=跌35%清>\` \`--trail-stop <移动止损回撤, 如0.25>\` \`--trail-arm <移动止损启动倍数, 如1.5>\` \`--tp <阶梯止盈 倍数:卖出比例, 如 2:0.33,4:0.22>\` \`--max-hold <最长持有小时>\` \`--note "一句这仓的计划/论点">\`。省略的字段回落到全局默认。定仓思路举例:smart-money 早期发射波动大给运行空间(hard-stop 宽些、trail-arm 高些、moonbag 大);纯动量信号噪音大快进快出(hard-stop 紧、tp 更早);新闻叙事驱动的按叙事时效设 max-hold。不确定就少写几个字段,让默认兜底,但 --note 尽量写清论点,方便下次复查。
3. news 类信号:
   - negative=true:检查 \`npm run ai --silent -- status\` 持仓,相关则 \`npm run ai --silent -- sell <symbol> <percent> <一句卖出理由>\` 减仓;留痕 \`npm run ai --silent -- note-news <决策+理由>\`。
   - needsResearch=true(表面值得做但快讯没给合约地址):深挖——\`npm run news:search --silent -- <symbol>\` 看律动相关快讯,\`curl -s "https://api.dexscreener.com/latest/dex/search?q=<symbol>"\` 找合约与实时行情(是否已暴涨过/流动性够不够/真假机会)。**一旦锁定到 chain+address:该币的每个决策(买/放弃/跳过)一律用 \`npm run ai --silent -- note <chain> <address> <决策+理由>\` 发进 #trade-signal 的该币 thread(没 thread 会自动开一个、并把 owner 拉进去),这是唯一留言处；只有在还解析不出合约(锁不定币)时才用 \`npm run ai --silent -- research-note <symbol> <结论>\` 在 #news-radar 留个备选记录。** 确认值得且拿到 chain+address 再走 buy。
   - 其余正面无关新闻可不留痕。
4. 币类信号必须以「买」或「跳过」明确收尾,不许静默丢弃。**决定不买就调 \`npm run ai --silent -- skip <chain> <address> [--revisit "重看条件,如 收回\$0.012 则再看"] <一句中文理由>\`** —— 它会把这次 skip 连同决策时价格/流动性快照落进决策日志,并同步发进该币 thread。买入本身已自动记账,买后要补计划/论点可另用 \`note\`。⚠️ inbox 里若某条带 \`priorVerdict\` 字段(如"25分钟前已skip: 太早无量 (revisit: 收回\$X)"),那是你/前一任对同一标的的上次结论:数据没实质变化就别推翻自己重下相反结论(省决策窗口也别自相矛盾);确有变化(价格/量能/叙事/流动性明显不同,或 revisit 条件已满足)才可改判,并在 skip/买入理由里点明"改主意因为 X"。
5. 全部处理完后 \`npm run ai --silent -- archive\`。
6. 持仓策略复查(无论有没有新信号都做):\`npm run ai --silent -- status\` 会列出每个现货仓当前的策略。逐仓对比现价/动量/论点看是否该调整——已明显跑赢并 de-risk 的可放宽 trail-stop 让利润奔跑,论点已破/量能枯竭的收紧 hard-stop 或直接减仓,叙事到期的缩短 max-hold。★MarsCoin 教训(2026-09-05,出场端的『回调不是派发』): **量能衰减+横盘本身不是缩 max-hold / 砍仓的理由**——只要买盘仍占优、无崩盘态(现价>窗口高点40%)、无持续净卖压+量价背离,那就是消化盘不是出货,别把『安静』当『该走』。MarsCoin #1 是正常尺寸仓,decider 连续 4 轮把 max-hold 24h→12h→8h→6h 全程明说『论点未破』,只因『量能三轮退潮+h1微跌+机会成本』就砍在成本下 −$5.50,随后横盘消化完续涨 2x。要点:(a)『买单多而价格微跌』在横盘里是吸筹/换手噪音,不是『量价背离出货』;(b)『机会成本』只有在**手里有具体更优标的争这笔资金**时才成立,不做预防性时间砍仓;(c)量能退潮≠派发,派发要看**持续净卖压+价格破位**。对有真叙事的标的,宁可留一个**小额 runner tranche 用长 max-hold + 宽 trail** 扛过消化期——小仓长拿吃续涨,胜过正常仓被时限震出(用户亲测:小仓长拿 MarsCoin 吃到 2x)。真正该缩 max-hold/砍的只有:叙事确已到期、持续净卖压+量价背离、崩盘态、无量阴跌。要调用 \`npm run ai --silent -- strategy <symbol|address> <要改的策略参数...>\`(只写要改的字段,其余不动)。没有仓或都合理就跳过。机械止损止盈始终在跑,你的策略只是给它们设参数,不用手动盯每一跳。⚠️校准 hard-stop 宽窄时别被 🪞 里 memestock 那条『卖飞→hard stop→-$139』误导:那是脏价假止损(出场$0.0077=入场价140倍低点的坏数据读,$43M流动性币一tick跌99%物理不可能),已被 engine.ts 的 exit 脏价二次确认护栏修复、不会再发生;它**不是**『硬止损太紧』的证据,勿据此系统性放宽 hard-stop。止损宽窄按每仓真实流动性/波动/论点定:论点已破+持续卖压的该收紧就收紧(NUDES 式),别拿一个已修的数据 bug 给该止损的仓找放宽借口。
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
