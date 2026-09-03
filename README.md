# Foxhole Bot (TypeScript)

Robinhood Chain meme intelligence — **Long.xyz** stock-paired launches, squeeze signals, alerts, and (roadmap) **auto-trading**.

**Live dashboard:** https://long.foxhole.bot

## Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Language | **TypeScript** | Matches Robinhood ecosystem |
| Chain SDK | **[hoodchain](https://www.npmjs.com/package/hoodchain)** | Stock quotes, swaps, launchpad watchers |
| RPC | **viem** + Alchemy | Stable on-chain reads |
| Market data | **DexScreener** | Free prices, volume, pairs |
| Web | Static `web/index.html` | long.foxhole.bot |

## Architecture

```
foxhole-bot (this repo — own & maintain)
├── hoodchain + viem     npm — chain reads & swaps (phase 2)
├── DexScreener          free HTTP — market data
├── discord.js           alerts (next)
└── sidecar MCPs         6551 twitter/news, GMGN research (optional)
```

**Reference repos:** see **[REFERENCES.md](./REFERENCES.md)** — full curated list (RB chain, Long.xyz, Pons, GMGN, OKX, 6551, Solana moonbags, etc.)

We **don't fork** other bots as our base; we **copy patterns** (exit logic, alert routing, risk caps) and build RB-specific execution on hoodchain.

## Quick start

```bash
cp .env.example .env   # add Alchemy ROBINHOOD_RPC

npm install
npm run fetch:long     # refresh launch list
npm run analyze -- 0x98096d17e191b3da1d5f99a6d7b3584351b11e18   # BONER analysis (RB)
npm run analyze -- --chain bsc 0x<token>                        # any chain: bsc/solana/base/ethereum
npm run deploy         # publish https://long.foxhole.bot
```

## Project layout

```
foxhole-bot/
├── src/
│   ├── chain/         # viem + hoodchain client
│   ├── dex/           # DexScreener client
│   ├── long/          # Long.xyz fetch, analyze, constants
│   └── cli/           # fetch-long, analyze commands
├── web/               # static dashboard
├── data/              # launches.json snapshot
├── REFERENCES.md      # all reference GitHub repos
└── scripts/deploy-local.sh
```

## Free RPC

1. Register at https://dashboard.alchemy.com
2. Create app → Robinhood Chain Mainnet
3. Put URL in `.env`:

```env
ROBINHOOD_RPC=https://robinhood-mainnet.g.alchemy.com/v2/YOUR_KEY
```

Public fallback: `https://rpc.mainnet.chain.robinhood.com` (rate limited).

## Roadmap

### Phase 1 — Monitor (done)
- [x] TypeScript rewrite
- [x] `analyze` — quote lock ratio + volume signals
- [x] Signal engine + BONER backtest (`npm run backtest`)
- [x] Monitor loop + Discord alerts (`npm run monitor`)
- [x] Long Factory launch watcher (verified `Created` topic; digest alerts + `npm run factory:backfill`)
- [x] Dashboard: lock ratio + signal columns (from `web/data/signals.json`)
- [x] Lock-ratio *rising* trigger (the actual BONER pattern)
- [x] Unit tests (`npm test`) + GitHub Actions CI

```bash
npm run backtest          # real historical replay (DexPaprika OHLCV)
npm run scan              # one-shot scan all Long.xyz tokens
npm run monitor:once      # single monitor cycle
npm run monitor           # continuous (set DISCORD_WEBHOOK_URL)
npm run factory:backfill -- --days=30   # seed launch list from factory events
npm test                  # vitest unit suite
```

Run the monitor as a service: `cp deploy/bot.foxhole.monitor.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/bot.foxhole.monitor.plist`

### Phase 2 — Auto-trading (RB chain)
- [x] `hoodchain` swap integration (quote → sign → execute; live mode)
- [x] Position tracker + trail/hard stop + tiered take-profits (ref: [moonbags](https://github.com/fciaf420/moonbags))
- [x] Risk engine: per-trade/daily caps, position limits, denylist, **paper mode default** (ref: [robinhood-chain-trading-bot](https://github.com/nirholas/robinhood-chain-trading-bot))
- [x] Entry signals: squeeze triggers (lock_strong / lock_rising_strong / boner_composite)
- [x] LLM exit advisor (optional): `TRADE_LLM_ADVISOR=1` + `ANTHROPIC_API_KEY`; early exits only, never overrides stops
- [ ] Live-mode gate: ≥2 weeks clean paper trading first (see `.env.example` TRADE_* vars)

```bash
TRADE_MODE=paper npm run monitor   # simulated entries/exits + daily P&L to Discord
npm run positions                  # portfolio report
```

Note: Long.xyz pools are Uniswap v4; hoodchain routes v3, so live swaps only
work for tokens with a v3 route — `NoRouteError` is surfaced, never swallowed.

### Multi-chain (see [PLAN-MULTICHAIN.md](./PLAN-MULTICHAIN.md)) — P0–P5 shipped
- [x] **P0**: chain adapters + trending/momentum monitoring for Solana, BSC, Base, ETH
  (`CHAINS=robinhood,solana,bsc,base,ethereum`), chain-aware paper trading
  (`TRADE_CHAINS=`), fast 15s position tick (`POSITION_TICK_MS`)
- [x] **P1**: BSC Four.meme `TokenCreate` watcher (verified on-chain) + PancakeSwap v2 execution
- [x] **P2**: Base Clanker v4 `TokenCreated` watcher (ABI mined from MIT sdk) + Uniswap v2 execution
- [x] **P3**: Solana pump.fun curve state (@pump-fun/pump-sdk) + graduation signals + Jupiter lite-api execution
  + pump.fun launch watcher (fresh mints → probation → DexScreener-verified graduation → analyzed/graded alert,
  symmetric to the four.meme pipeline; `PUMP_MIN_DISCOVERY_MCAP`/`PUMP_MIN_LIQUIDITY_USD`)
- [x] **P4**: ETH Uniswap v2/v3 new-WETH-pair watcher (monitor-only by design)
- [x] **P5**: GoPlus safety gate — hard entry veto on honeypot/taxes>10%/mint/rug mechanics (`TRADE_SAFETY_GATE=0` to disable)
- [x] **Self-review loop** (see [PLAN-SELFTUNE.md](./PLAN-SELFTUNE.md)): daily alert
  grading vs 24h price action, missed-暴涨 scan, bounded backtest-gated
  auto-tuning via `data/signal-overrides.json` (`npm run review`,
  `AUTO_TUNE_PUSH=1` for auto-commit)
- [~] Per-chain backtest fixtures (RB + Base/BSC/ETH/SOL pump+control, engine-classified
  via real OHLCV replay — SOL: FARTCOIN/POPCAT pumps, SILLY control) + ≥2-week paper gate before any live mode

⚠️ **All non-Robinhood live execution paths are UNTESTED with real funds.**
Paper mode (`TRADE_MODE=paper`) is the default and works on every chain.
Live keys: `TRADER_PRIVATE_KEY` (RB), `BSC_PRIVATE_KEY`, `BASE_PRIVATE_KEY`,
`SOLANA_PRIVATE_KEY` — throwaway wallets only.

### Hyperliquid perps — 新闻驱动做多/做空 (`src/venues/hyperliquid/`)
永续场馆,和现货 `TRADE_*` 完全独立,自成一档 `HL_*` 配置;**默认 `HL_MODE=off` 时整套逻辑休眠**。
- [x] 只读行情层(零依赖 `/info` fetch:价格、宇宙、`metaAndAssetCtxs`);符号解析含 meme 的小写 **k 前缀**(`PEPE→kPEPE`)与大小写/别名匹配
- [x] 方向感知的止损止盈:硬止损 / 移动止损 / 止盈阶梯 / 最大持仓,多空对称
- [x] 风控门 `checkPerpEntry`:名义敞口单笔+24h 上限、最大持仓数、去重、杠杆硬顶,且**硬止损必须早于强平**(否则拒绝,防爆仓亏光保证金)
- [x] paper 账户 P&L(权益 = 起始 + 已实现 + 未实现,保证金不扣)+ 每 24h Discord 日报;逼近强平预警(30min 节流)
- [x] 决策 AI 集成:`HL_MODE≠off` 时 decider 追加永续段,用 `hl stat`(现价+24h涨跌+资金费)判断"是否已被 price in",再 `hl long/short`(全过风控门)
- [x] live 签名走 `@nktkas/hyperliquid`(可选依赖,IOC 模拟市价);**未经真金验证**,先 testnet
  - HIP-3 美股/商品 dex:live 下单已实现 asset id 编码(`100000+perp_dex_index*10000+下标`,`perp_dex_index` 取自 `perpDexs`);同样先 testnet 核对再上主网
- [ ] Live-mode gate:testnet 跑通 + ≥2 周 paper 后再上主网(见 `.env.example` HL_* 段)

```bash
HL_MODE=paper npm run hl -- long BTC 50 3 利好XX   # 开多(名义$50, 3x)
npm run hl -- short ETH 40 3 利空XX                # 开空
npm run hl -- stat pepe    # 现价+24h涨跌+资金费(→ kPEPE)   npm run hl -- status
npm run hl -- close BTC 50 # 平 50%                npm run hl -- markets
```
永续持仓由 monitor 的 `positionLoop`(~15s)自动托管止损止盈(与现货并列)。
live agent 私钥:`HL_AGENT_KEY`(app.hyperliquid.xyz/API 生成、无提现权)。

### Phase 3 — Multi-signal
- [ ] Pons launchpad module
- [ ] 6551 Twitter meme sentiment (`opennews-mcp`)
- [ ] GMGN Robinhood research (`hoodly-gmgn-robinhood-mcp`)
- [ ] OKX smart money (if RB coverage expands)

### Optional — Solana parallel
- [ ] Fork [moonbags](https://github.com/fciaf420/moonbags) as separate repo if trading SOL memes too

## Key references (short list)

| Repo | Borrow for |
|------|------------|
| [nirholas/robinhood-chain-trading-bot](https://github.com/nirholas/robinhood-chain-trading-bot) | RB auto-trading, risk caps, strategies |
| [fciaf420/moonbags](https://github.com/fciaf420/moonbags) | Trail/stop, LLM exit, Telegram UX |
| [nirholas/robinhood-volume-alerts](https://github.com/nirholas/robinhood-volume-alerts) | Volume spike detection |
| [hoodly-agent/hoodly-gmgn-robinhood-mcp](https://github.com/hoodly-agent/hoodly-gmgn-robinhood-mcp) | GMGN RB research |
| [6551Team/opennews-mcp](https://github.com/6551Team/opennews-mcp) | News + meme Twitter sentiment |
| [6551Team/opentwitter-mcp](https://github.com/6551Team/opentwitter-mcp) | KOL / tweet monitoring |
| [ponsdotdev/ponsfamily](https://github.com/ponsdotdev/ponsfamily) | Pons contracts & graduation |
| [okx/onchainos-skills](https://github.com/okx/onchainos-skills) | Smart money + trenches |
| [GMGNAI/gmgn-skills](https://github.com/GMGNAI/gmgn-skills) | GMGN agent skills |

Full list → **[REFERENCES.md](./REFERENCES.md)**

## Contracts

- Long.xyz Factory: `0x22e99278308b393ea1260859b181ad7e78f5eeed`
- Long.xyz Airlock: `0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862`
- Pons V2 Factory: `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801ec7e`
- Chain ID: `4663`
