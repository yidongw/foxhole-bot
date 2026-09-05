import { appendJournal } from "./journal-store.js";
import type { ClassifiedMover } from "./movers.js";

/**
 * 过滤日志 — records EVERY mover judgment (kept and filtered alike, with the
 * numbers behind each verdict) so filter quality is auditable. Now rows in the
 * SQLite journal table (kind=filter), not per-day markdown files.
 */

export function moverVerdict(m: ClassifiedMover): { verdict: string; reason: string } {
  if (m.kind === "alerted") return { verdict: "已报警", reason: "我们提前发过警报" };
  if (m.ladder) return { verdict: "过滤", reason: "🪜 刷单画线 (梯子图形)" };
  if (m.noData) return { verdict: "过滤", reason: "💀 无K线数据 (疑似池子已抽干)" };
  if (m.safetyFlags?.length) {
    return { verdict: "过滤", reason: `🚨 ${m.safetyFlags.join(", ")}` };
  }
  if (m.collapsed) return { verdict: "标注", reason: "📉 已崩盘 (现价 < 峰值40%)" };
  return { verdict: "候选", reason: "通过全部自动过滤 → 待人工确认" };
}

/** Compact per-mover lines for the 过滤日志 Discord channel. */
export function formatFilterDigest(title: string, movers: ClassifiedMover[]): string {
  const lines = [`🧹 **过滤日志 — ${title}** (${movers.length} 个)`];
  for (const m of movers.slice(0, 15)) {
    const { verdict, reason } = moverVerdict(m);
    lines.push(
      `${verdict === "候选" ? "🟢" : verdict === "已报警" ? "✅" : "⛔"} ` +
        `${m.symbol ?? m.address.slice(0, 8)} [${m.chain}] +${m.priceChange24h.toFixed(0)}% — ${verdict}: ${reason}`,
    );
  }
  if (movers.length > 15) lines.push(`… 还有 ${movers.length - 15} 个,详见 journal/filters/`);
  return lines.join("\n");
}

export async function appendFilterJournal(
  title: string,
  movers: ClassifiedMover[],
): Promise<void> {
  const lines = [
    `## ${new Date().toISOString().slice(11, 16)} UTC — ${title}`,
    "",
    "| 币 | 链 | 24h | 量 | 池 | 判定 | 原因 |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const m of movers) {
    const { verdict, reason } = moverVerdict(m);
    lines.push(
      `| ${m.symbol ?? m.address.slice(0, 8)} | ${m.chain} | +${m.priceChange24h.toFixed(0)}% | $${(m.volume24hUsd / 1e6).toFixed(1)}M | $${(m.liquidityUsd / 1e3).toFixed(0)}K | ${verdict} | ${reason} |`,
    );
    lines.push(`| | | | | | | \`${m.address}\` |`);
  }
  appendJournal("filter", lines.join("\n"));
}

/** Record the human's phase-2 decisions in the same day file. */
export async function appendFilterDecisions(
  confirmed: ClassifiedMover[],
  excluded: ClassifiedMover[],
): Promise<void> {
  const lines = [
    `## ${new Date().toISOString().slice(11, 16)} UTC — 人工确认`,
    ...confirmed.map((m) => `- ✅ 确认 ${m.symbol} [${m.chain}] → 进案例库`),
    ...excluded.map((m) => `- 🚫 剔除 ${m.symbol} [${m.chain}] → 永久黑名单 \`${m.address}\``),
  ];
  if (!confirmed.length && !excluded.length) lines.push("- (空清单)");
  appendJournal("filter", lines.join("\n"));
}
