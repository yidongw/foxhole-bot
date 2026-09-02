import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";

import {
  exitAllPositions,
  formatPortfolioReport,
  manualExit,
  setTradingPaused,
  tradingPaused,
} from "../trade/engine.js";
import { loadTradeConfig } from "../trade/config.js";
import { enabledChains, tradeEnabledChains } from "../chains/adapter.js";

/**
 * Interactive control surface (moonbags-style, rebuilt on discord.js).
 * Gated on DISCORD_BOT_TOKEN; set DISCORD_GUILD_ID for instant command
 * registration (global commands take up to an hour to propagate).
 *
 * Pause blocks NEW entries only — exits and stops always keep running.
 */

const COMMANDS = [
  new SlashCommandBuilder()
    .setName("positions")
    .setDescription("Show open positions and P&L"),
  new SlashCommandBuilder()
    .setName("sell")
    .setDescription("Manually exit a position")
    .addStringOption((o) =>
      o.setName("token").setDescription("Symbol or address").setRequired(true),
    )
    .addIntegerOption((o) =>
      o
        .setName("percent")
        .setDescription("Percent of remaining to sell (default 100)")
        .setMinValue(1)
        .setMaxValue(100),
    ),
  new SlashCommandBuilder()
    .setName("sellall")
    .setDescription("Exit every open position"),
  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause new entries (exits keep running)"),
  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume new entries"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Monitor + trading status"),
  new SlashCommandBuilder()
    .setName("review-confirm")
    .setDescription("确认每日暴涨候选清单(剔除的进永久黑名单)")
    .addStringOption((o) =>
      o
        .setName("exclude")
        .setDescription("要剔除的编号,逗号分隔,如 1,3(留空=全部通过)"),
    ),
].map((c) => c.toJSON());

let started = false;

export async function startControlBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || started) return;
  started = true;

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once("clientReady", async () => {
    try {
      const rest = new REST().setToken(token);
      const appId = client.user!.id;
      const guildId = process.env.DISCORD_GUILD_ID;
      await rest.put(
        guildId
          ? Routes.applicationGuildCommands(appId, guildId)
          : Routes.applicationCommands(appId),
        { body: COMMANDS },
      );
      console.log(
        `control bot ready as ${client.user!.tag} (${guildId ? "guild" : "global"} commands)`,
      );
    } catch (err) {
      console.error("control bot command registration failed:", (err as Error).message);
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      await interaction.deferReply();
      let reply: string;
      switch (interaction.commandName) {
        case "positions":
          reply = await formatPortfolioReport();
          break;
        case "sell": {
          const query = interaction.options.getString("token", true);
          const percent = interaction.options.getInteger("percent") ?? 100;
          reply = await manualExit(query, percent / 100);
          break;
        }
        case "sellall":
          reply = await exitAllPositions();
          break;
        case "pause":
          await setTradingPaused(true);
          reply = "⏸️ New entries paused. Exits and stops keep running.";
          break;
        case "resume":
          await setTradingPaused(false);
          reply = "▶️ New entries resumed.";
          break;
        case "review-confirm": {
          const raw = interaction.options.getString("exclude") ?? "";
          const exclude = raw
            .split(",")
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n) && n > 0);
          const { confirmMovers } = await import("../review/daily.js");
          const result = await confirmMovers(exclude);
          reply =
            "error" in result
              ? result.error
              : `已确认 ${result.confirmed.length} 个, 剔除 ${result.excluded.length} 个进黑名单。` +
                (result.tune.adopted
                  ? `\n🔧 调参已采纳: ${JSON.stringify(result.tune.changes)}`
                  : `\n🔧 调参: 无变更 — ${result.tune.reason}`);
          break;
        }
        case "status": {
          const config = loadTradeConfig();
          reply = [
            `Chains: ${enabledChains().join(", ")}`,
            `Trade mode: ${config.mode} (chains: ${tradeEnabledChains().join(", ")})`,
            `Entries: ${tradingPaused() ? "⏸️ paused" : "active"}`,
            `Caps: $${config.usdPerTrade}/trade, $${config.maxDailySpendUsd}/day, max ${config.maxOpenPositions} open`,
          ].join("\n");
          break;
        }
        default:
          reply = "Unknown command.";
      }
      await interaction.editReply(reply.slice(0, 2000));
    } catch (err) {
      console.error("control bot interaction failed:", (err as Error).message);
      await interaction
        .editReply(`Error: ${(err as Error).message}`.slice(0, 2000))
        .catch(() => {});
    }
  });

  await client.login(token);
}
