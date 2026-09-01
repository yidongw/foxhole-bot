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
npm run analyze -- 0x98096d17e191b3da1d5f99a6d7b3584351b11e18   # BONER analysis
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

### Phase 1 — Monitor (done / in progress)
- [x] TypeScript rewrite
- [x] `analyze` — quote lock ratio + volume signals
- [x] Signal engine + BONER backtest (`npm run backtest`)
- [x] Monitor loop + Discord alerts (`npm run monitor`)
- [ ] Long Factory `Created` event watcher
- [ ] Dashboard: lock ratio column

```bash
npm run backtest          # real historical replay (DexPaprika OHLCV)
npm run scan              # one-shot scan all Long.xyz tokens
npm run monitor:once      # single monitor cycle
npm run monitor           # continuous (set DISCORD_WEBHOOK_URL)
```

### Phase 2 — Auto-trading (RB chain)
- [ ] `hoodchain` swap integration (quote → sign → execute)
- [ ] Position tracker + trail/stop exit (ref: [moonbags](https://github.com/fciaf420/moonbags))
- [ ] Risk engine: max spend, paper mode (ref: [robinhood-chain-trading-bot](https://github.com/nirholas/robinhood-chain-trading-bot))
- [ ] Entry signals: launch snipe + squeeze trigger (BONER-style lock ratio rise)
- [ ] Optional: LLM exit advisor

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
