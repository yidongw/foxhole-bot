#!/usr/bin/env node
import { loadEnv } from "../lib/env.js";
loadEnv();

import { loadHlConfig } from "../venues/hyperliquid/config.js";
import { fetchAssetContext, fetchMidPrice } from "../venues/hyperliquid/info.js";
import {
  tradableSymbols,
  resolveHlSymbol,
  matchUniverseSymbol,
} from "../venues/hyperliquid/symbols.js";
import {
  closePerp,
  formatPerpReport,
  managePerpPositions,
  openPerp,
} from "../venues/hyperliquid/engine.js";

/**
 * Hyperliquid 永续 CLI —— 新闻交易的执行入口(和现货 ai-trade 平行)。
 * 决策 AI / 人 都只能通过这里动仓,全程过 HL_* 风控门。
 *
 *   hl long  <symbol> <usd> [leverage] [reason...]   开多
 *   hl short <symbol> <usd> [leverage] [reason...]   开空
 *   hl close <symbol> [percent]                      平仓(默认 100%)
 *   hl manage                                         跑一次持仓管理 tick(止损止盈)
 *   hl status                                         永续持仓 + 账户
 *   hl price <symbol>                                 查 mid 价
 *   hl stat  <symbol>                                 现价 + 24h 涨跌 + 资金费(判断是否 price in)
 *   hl markets [关键词]                               列可交易符号
 *   hl resolve <新闻词>                               新闻词 → HL 符号(调试)
 */

async function main() {
  const [cmd, ...args] = process.argv.slice(2).filter((a) => a !== "--");
  const config = loadHlConfig();

  switch (cmd) {
    case "long":
    case "short": {
      const [symbol, usd, maybeLev, ...reason] = args;
      if (!symbol || !usd) {
        console.error(`用法: hl ${cmd} <symbol> <usd> [leverage] [reason...]`);
        process.exit(1);
      }
      // leverage 可选:若第 3 个参数是数字当杠杆,否则并入理由。
      const levNum = maybeLev != null ? Number(maybeLev) : NaN;
      const leverage = Number.isFinite(levNum) ? levNum : undefined;
      const reasonText = (leverage == null && maybeLev != null ? [maybeLev, ...reason] : reason)
        .join(" ")
        .trim();
      console.log(
        await openPerp(
          cmd === "long" ? "long" : "short",
          symbol,
          Number(usd),
          leverage,
          reasonText || "无",
          config,
        ),
      );
      break;
    }
    case "close": {
      const [symbol, percent] = args;
      if (!symbol) {
        console.error("用法: hl close <symbol> [percent]");
        process.exit(1);
      }
      console.log(await closePerp(symbol, (Number(percent) || 100) / 100, config));
      break;
    }
    case "manage":
      await managePerpPositions(config);
      console.log("perp manage tick done");
      break;
    case "status":
      console.log(await formatPerpReport(config));
      break;
    case "price": {
      const [symbol] = args;
      if (!symbol) {
        console.error("用法: hl price <symbol>");
        process.exit(1);
      }
      const px = await fetchMidPrice(config.testnet, symbol.toUpperCase(), config.dex || undefined);
      console.log(px != null ? `${symbol.toUpperCase()} mid = $${px}` : `${symbol} 取不到价格`);
      break;
    }
    case "stat": {
      const [symbol] = args;
      if (!symbol) {
        console.error("用法: hl stat <symbol>");
        process.exit(1);
      }
      // 判断"是否已被 price in / 追高":现价 + 24h 涨跌 + 资金费率(拥挤度)。
      const matched = await matchUniverseSymbol(symbol, config);
      if (!matched) {
        console.log(`${symbol} 匹配不到可交易符号`);
        break;
      }
      const ctx = await fetchAssetContext(config.testnet, matched, config.dex || undefined);
      if (!ctx) {
        console.log(`${matched} 取不到行情`);
        break;
      }
      const annualized = ctx.funding * 24 * 365 * 100;
      console.log(
        `${matched}: mark $${ctx.markPx} | 24h ${ctx.dayChangePct >= 0 ? "+" : ""}${ctx.dayChangePct.toFixed(2)}% | ` +
          `资金费/时 ${(ctx.funding * 100).toFixed(4)}%(年化≈${annualized >= 0 ? "+" : ""}${annualized.toFixed(0)}%) | OI ${ctx.openInterest}`,
      );
      break;
    }
    case "markets": {
      const q = (args[0] ?? "").toUpperCase();
      const set = await tradableSymbols(config);
      const list = [...set].filter((s) => !q || s.includes(q)).sort();
      console.log(`${list.length} 个可交易符号${config.dex ? ` (dex=${config.dex})` : ""}:`);
      console.log(list.join(", "));
      break;
    }
    case "resolve": {
      const [term] = args;
      if (!term) {
        console.error("用法: hl resolve <新闻词>");
        process.exit(1);
      }
      // 宇宙感知:含大小写与 meme 的 k 前缀(PEPE→kPEPE)。给决策 AI 用的就是这个结果。
      const matched = await matchUniverseSymbol(term, config);
      if (matched) {
        console.log(`"${term}" → ${matched} (✅ 可交易)`);
        break;
      }
      const guess = resolveHlSymbol(term);
      console.log(
        guess
          ? `"${term}" → ${guess} (⚠️ 不在宇宙内,不可交易)`
          : `"${term}" → 解析不出符号`,
      );
      break;
    }
    default:
      console.error(
        "用法: hl long|short|close|manage|status|price|stat|markets|resolve",
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
