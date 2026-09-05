/**
 * 真实账户入出金台账 CLI。
 *
 *   npm run capital -- deposit 80 "初始充值"
 *   npm run capital -- withdraw 30 "提现到交易所"
 *   npm run capital -- deposit 50 "加仓" --at 2026-09-10T12:00:00Z
 *   npm run capital -- list
 *
 * 台账是 web/data/capital-flows.json（+ = 收到钱, - = 提走）。仪表盘「权益曲线」
 * 在「只看 LIVE」时用它作基准：起始 = 净入金，每笔充值/提现都带时间标出来。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLOWS_PATH = path.resolve(__dirname, "../../web/data/capital-flows.json");

interface Flow {
  at: string;
  usd: number;
  mode?: string;
  chain?: string;
  note?: string;
}

async function load(): Promise<Flow[]> {
  try {
    const j = JSON.parse(await readFile(FLOWS_PATH, "utf8"));
    return Array.isArray(j.flows) ? j.flows : [];
  } catch {
    return [];
  }
}

async function save(flows: Flow[]): Promise<void> {
  flows.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  await mkdir(path.dirname(FLOWS_PATH), { recursive: true });
  await writeFile(
    FLOWS_PATH,
    JSON.stringify(
      {
        updated_at: new Date().toISOString(),
        note: "真实账户入出金台账（+ = 充值/收到, - = 提现）。用 `npm run capital` 追加，或直接手改本文件。",
        flows,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

const fmt = (n: number) => (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toFixed(2);

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [cmd, amountRaw, ...rest] = process.argv.slice(2);
  const flows = await load();

  if (!cmd || cmd === "list") {
    if (!flows.length) {
      console.log("（台账为空）");
      return;
    }
    let net = 0;
    for (const f of flows) {
      net += f.usd;
      console.log(
        `${f.at}  ${fmt(f.usd).padStart(10)}  净入金 ${fmt(net).padStart(10)}  ${f.note ?? ""}`,
      );
    }
    console.log(`\n净入金合计: ${fmt(net)}`);
    return;
  }

  if (cmd !== "deposit" && cmd !== "withdraw") {
    console.error(
      "用法: npm run capital -- <deposit|withdraw> <usd> [note] [--at ISO]\n" +
        "     npm run capital -- list",
    );
    process.exit(1);
  }

  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error(`金额无效: ${amountRaw}`);
    process.exit(1);
  }
  const note = rest.filter((a) => !a.startsWith("--") && a !== argValue("--at")).join(" ");
  const at = argValue("--at") ?? new Date().toISOString();
  if (Number.isNaN(new Date(at).getTime())) {
    console.error(`时间无效: ${at}`);
    process.exit(1);
  }

  const flow: Flow = {
    at: new Date(at).toISOString(),
    usd: cmd === "withdraw" ? -amount : amount,
    mode: "live",
    note: note || (cmd === "withdraw" ? "提现" : "充值"),
  };
  flows.push(flow);
  await save(flows);
  const net = flows.reduce((s, f) => s + f.usd, 0);
  console.log(
    `已记录 ${cmd === "withdraw" ? "提现" : "充值"} ${fmt(flow.usd)} @ ${flow.at}` +
      (flow.note ? ` · ${flow.note}` : ""),
  );
  console.log(`净入金合计: ${fmt(net)}  → 已写入 ${FLOWS_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
