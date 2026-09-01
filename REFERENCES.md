# Reference Repos — Meme Trading Intelligence

Curated GitHub / npm / MCP references for **foxhole-bot**.  
Goal: Robinhood Chain auto-trading (Long.xyz squeeze + launch sniping), plus cross-chain signal sources.

**How to use this list**

| Action | When |
|--------|------|
| `npm install` | Published SDK (`hoodchain`, `viem`) |
| Read / copy patterns | Bot architecture, exit logic, alert routing |
| Run as sidecar MCP | Twitter/news/GMGN research (Cursor or HTTP) |
| Fork only if needed | Solana parallel stack (moonbags) — not as RB base |

---

## 🎯 foxhole-bot architecture (target)

```
┌─────────────────────────────────────────────────────────────┐
│  foxhole-bot (this repo) — Robinhood Chain runtime           │
├──────────────┬──────────────────┬───────────────────────────┤
│  Discovery   │  Analysis        │  Execution (phase 2)      │
│  Long/Pons   │  lock ratio      │  hoodchain swap           │
│  Factory     │  volume spike    │  trail/stop (moonbags)    │
│  GMGN RB     │  premium         │  risk caps (hood-traders) │
├──────────────┴──────────────────┴───────────────────────────┤
│  Signals (sidecar)                                           │
│  6551 Twitter/News · OKX smart money · Discord alerts      │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. Robinhood Chain — Core SDK & infra

| Repo | Stars | Lang | What to borrow |
|------|-------|------|----------------|
| [nirholas/robinhood-chain-sdk](https://github.com/nirholas/robinhood-chain-sdk) | — | TS | **hoodchain** — Stock quotes, swap routing, launchpad watchers, firehose |
| [nirholas/robinhood-chain-kit](https://github.com/nirholas/robinhood-chain-kit) | — | TS | Streams, SQLite indexer, multicall, React hooks, TWAP executor |
| [nirholas/robinhood-chain-js](https://github.com/nirholas/robinhood-chain-js) | — | TS | Thin facade: `hood.price()`, `hood.launches()`, `hood.quote()` |
| [nirholas/robinhood-chain-cli](https://github.com/nirholas/robinhood-chain-cli) | — | TS | CLI patterns for launches, swaps, wallet onboarding |
| [nirholas/robinhood-toolkit](https://github.com/nirholas/robinhood-toolkit) | — | TS | Monitoring, `/healthz`, alert severity routing |
| [nirholas/robinhood-chain-x402](https://github.com/nirholas/robinhood-chain-x402) | — | TS | x402 USDG payments (premium alerts) |

**npm:** `hoodchain`, `hoodkit`, `hood-js`, `hood-cli`, `hood-traders`

---

## 2. Robinhood Chain — Auto-trading & alerts ⭐

Primary references for **phase 2 execution**:

| Repo | Lang | What to borrow |
|------|------|----------------|
| [nirholas/robinhood-chain-trading-bot](https://github.com/nirholas/robinhood-chain-trading-bot) | TS | **Best RB match** — launch sniper, momentum, stock premium arb, LLM strategist, paper mode, risk caps, P&L dashboard |
| [nirholas/robinhood-chain-alert-bot](https://github.com/nirholas/robinhood-chain-alert-bot) | TS | Discord/Telegram/X alerts — launches, graduations, whale, rug warnings |
| [nirholas/robinhood-volume-alerts](https://github.com/nirholas/robinhood-volume-alerts) | TS | Volume spike detection (learned baseline), whale prints, launch/graduation |

**From Solana (copy logic, not chain code):**

| Repo | Lang | What to borrow |
|------|------|----------------|
| [fciaf420/moonbags](https://github.com/fciaf420/moonbags) | TS | Trail/stop exit, LLM exit advisor, multi-source signals, Telegram UX, position persistence |
| [okx/plugin-store smart-money-signal-copy-trade](https://web3.okx.com/onchainos/plugins/detail/smart-money-signal-copy-trade) | Py | Co-rider consensus entry, 15 safety filters, 7-layer exit |
| [okx/plugin-store meme-trench-scanner](https://web3.okx.com/onchainos/plugins/detail/meme-trench-scanner) | Py | Launchpad scanner, TX acceleration signals, tiered TP |

---

## 3. Robinhood Chain — Launchpads

### Long.xyz (stock-paired meme — foxhole focus)

| Resource | Type | What to borrow |
|----------|------|----------------|
| [Mobula Long.xyz integration](https://docs.mobula.io/almanac/robinhood-launchpads/longxyz) | Docs | Factory/Airlock ABI, Uniswap v4 PoolId, epoch progress, `Swap`/`ModifyLiquidity` indexing |
| **foxhole-bot** `src/long/` | Code | DexScreener discovery, quote lock ratio, BONER-style squeeze |

Contracts:
- Factory: `0x22e99278308b393ea1260859b181ad7e78f5eeed`
- Airlock: `0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862`

### Pons (ponsfamily.com)

| Repo / Resource | Type | What to borrow |
|-----------------|------|----------------|
| [ponsdotdev/ponsfamily](https://github.com/ponsdotdev/ponsfamily) | Solidity | V1/V2 factory, bonding curve → V4 graduation, `LaunchFactory` events |
| [Bitquery Pons API docs](https://docs.bitquery.io/docs/blockchain/robinhood/pons-api/) | Docs | `TokenLaunched`, curve trades, graduation, MemeHook fee events |
| [hoodly-agent MCP — Pons](https://glama.ai/mcp/connectors?query=namespace%3Aio.github.hoodly-agent) | MCP | `https://mcp-pons.hoodly.ai/mcp` — V1 trading, V2 curve reads |

Contracts:
- V1 factory: `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`
- V2 factory: `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`
- V2 MemeHook: `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044`

### Other RB launchpads (hoodchain built-in)

| Launchpad | hoodchain API | Notes |
|-----------|---------------|-------|
| NOXA | `watchLaunches`, `getRecentLaunches` | Instant pool on launch |
| The Odyssey | `watchLaunches`, `watchGraduations` | Bonding curve → graduation |
| Bankr | GMGN / DexScreener | Stock-paired competitor to Long.xyz |
| Bottom.fun, NoxaFun | Mobula almanac | Secondary launchpads |

Docs: [Robinhood Chain launchpads (Mobula)](https://docs.mobula.io/almanac/robinhood-launchpads/)

---

## 4. Hoodly MCP ecosystem (Robinhood research)

Hosted MCPs — use in Cursor or call via HTTP; **read-only**, no signing.

| MCP | URL | Tools |
|-----|-----|-------|
| [hoodly-gmgn-robinhood-mcp](https://github.com/hoodly-agent/hoodly-gmgn-robinhood-mcp) | `https://gmgn.hoodly.io/mcp` | RB launches, trending, token research, kline, daily brief |
| Pons Launchpad MCP | `https://mcp-pons.hoodly.ai/mcp` | Pons V1/V2 launch data |
| Rialto Swap MCP | `https://mcp-rialto.hoodly.io/mcp` | Quote preflight (read-only) |

Requires `GMGN_API_KEY` from https://gmgn.ai/ai

---

## 5. GMGN — Multi-chain meme data & execution

| Repo | Lang | Chains | What to borrow |
|------|------|--------|----------------|
| [GMGNAI/gmgn-skills](https://github.com/GMGNAI/gmgn-skills) | TS | SOL, BSC, Base, ETH… | Skills: `/gmgn-token`, `/gmgn-market`, `/gmgn-track`, `/gmgn-swap`, `/gmgn-cooking` |
| [wangschang/gmgn-skills](https://github.com/wangschang/gmgn-skills) | TS | SOL, BSC, Base | Fork with CLI examples |
| [GMGN Agent API docs](https://docs.gmgn.ai/index/gmgn-agent-api) | Docs | — | API key + Ed25519 keypair setup |
| [hoodly-gmgn-robinhood-mcp](https://github.com/hoodly-agent/hoodly-gmgn-robinhood-mcp) | TS | **Robinhood** | RB-specific research boundary |

**npm:** `gmgn-cli` — `npx gmgn-cli market trending --chain robinhood`

Note: GMGN swap skills target SOL/BSC/Base today; Robinhood execution → use **hoodchain** swap module.

---

## 6. OKX OnchainOS — Smart money & trenches

| Repo | Lang | Chains | What to borrow |
|------|------|--------|----------------|
| [okx/onchainos-skills](https://github.com/okx/onchainos-skills) | TS | 20+ chains | Skills: wallet, security, market, signal, trenches, swap |
| [okx/plugin-store](https://web3.okx.com/onchainos/plugins/) | Py/TS | Mostly SOL | Copy-trade bot, trench scanner plugins |

Key skills:
- `okx-dex-signal` — smart money / KOL / whale buy alerts
- `okx-dex-trenches` — `memepump tokens`, dev rug history, bundler detection
- `okx-dex-swap` — DEX aggregation execution

CLI: `onchainos signal list`, `onchainos memepump tokens`, `onchainos ws start`

---

## 7. Twitter / News / Meme sentiment

| Repo | Lang | What to borrow |
|------|------|----------------|
| [6551Team/opennews-mcp](https://github.com/6551Team/opennews-mcp) | Python | 85+ sources — news, listing, onchain whale, **meme Twitter sentiment**, market anomalies, AI prediction signals |
| [6551Team/opentwitter-mcp](https://github.com/6551Team/opentwitter-mcp) | Python | KOL tracking, tweet search, watch lists, deleted tweets |
| [6551-io/twitter-mcp](https://github.com/6551-io/twitter-mcp) | Python | Older Twitter MCP variant |
| [NewsLiquid](https://newsliquid.com/) | SaaS | Full-stack AI trading terminal (6551-backed), news impact scorer, OpenTrade execution |

Token: https://6551.io/mcp or https://app.newsliquid.com/mcp

**foxhole use case:** `get_news_by_engine(engine_type="meme")` + `add_twitter_watch` for Long.xyz KOL accounts.

---

## 8. Solana — Meme trading (cross-chain reference)

| Repo | Stars | Lang | What to borrow |
|------|-------|------|----------------|
| [fciaf420/moonbags](https://github.com/fciaf420/moonbags) | ~35 | TS | **Exit management**, GMGN/OKX signal intake, Telegram bot, LLM advisor |
| [chainstacklabs/pumpfun-bonkfun-bot](https://github.com/chainstacklabs/pumpfun-bonkfun-bot) | ~970 | Python | Sniper architecture, Geyser listener, YAML bot configs, learning examples |
| [chainstacklabs/pumpfun-cli](https://github.com/chainstacklabs/pumpfun-cli) | — | TS | CLI trading + smart routing |
| [chainstacklabs/pumpclaw](https://github.com/chainstacklabs/pumpclaw) | — | Skill | Agent skill for pumpfun-cli |
| [bitman09/pumpfun-buy-sell-bot](https://github.com/bitman09/pumpfun-buy-sell-bot) | — | TS | Geyser sniper, TP/SL, filter pipeline |
| [steelforge-labs/solana-pumpfun-sniper-trading-bot](https://github.com/steelforge-labs/solana-pumpfun-sniper-trading-bot) | — | TS | 0-block Jito/NextBlock submission |
| [JadenMassari/pumpfun-memecoin-sniper](https://github.com/JadenMassari/pumpfun-memecoin-sniper) | ~37 | TS | Anti-rug, MEV, multi-wallet |

**Fork moonbags?** Only if you also want a **Solana** trading stack in parallel. For RB chain, copy exit/position patterns into foxhole-bot.

---

## 9. BSC — Four.meme

| Repo | Lang | What to borrow |
|------|------|----------------|
| [0xfnzero/four-trading-sdk](https://github.com/0xfnzero/four-trading-sdk) | TS | Four.meme buy/sell, event streams, quotes |
| [meme-sdk/fourmeme-trading](https://github.com/meme-sdk/fourmeme-trading) | TS | Migration detection → PancakeSwap routing |
| [carzygod/four-meme-sdk](https://github.com/carzygod/four-meme-sdk) | JS | Full lifecycle: deploy, buy, sell |
| [svendotdev/BNB-Four.meme-sniper-bot](https://github.com/svendotdev/BNB-Four.meme-sniper-bot) | — | Sniper patterns |

---

## 10. Base / Ethereum — Clanker & others

| Repo | Lang | What to borrow |
|------|------|----------------|
| [clanker-devco/clanker-sdk](https://github.com/clanker-devco/clanker-sdk) | TS | Base token deploy + pool config |
| GMGN skills | TS | Clanker / FourMeme launchpad filters in trenches |

---

## 11. Market data (free / API)

| Service | Cost | RB support | Use |
|---------|------|------------|-----|
| [DexScreener API](https://docs.dexscreener.com/) | Free | ✅ `chainId=robinhood` | Prices, volume, pair discovery |
| [Mobula API](https://docs.mobula.io/) | Freemium | ✅ RB launchpads | Factory events, metadata |
| [Bitquery GraphQL](https://docs.bitquery.io/) | Freemium | ✅ Pons/Long indexing | On-chain event queries |
| [GMGN OpenAPI](https://docs.gmgn.ai/) | API key | ✅ Robinhood chain param | RB launches, security, holders |
| Alchemy RPC | Free tier | ✅ chain 4663 | Reliable reads for trading |

---

## 12. foxhole-bot integration priority

| Phase | Module | Primary reference |
|-------|--------|-------------------|
| **Now** | Long.xyz monitor + squeeze | foxhole `analyze`, Mobula docs |
| **Next** | Discord alerts | `robinhood-volume-alerts`, `hood-alerts` |
| **Phase 2a** | Swap execution | `hoodchain` swap + `robinhood-chain-trading-bot` risk engine |
| **Phase 2b** | Exit management | `moonbags` trail/stop + optional LLM |
| **Phase 2c** | Multi-signal | `opennews-mcp` meme + `hoodly-gmgn-robinhood-mcp` |
| **Phase 3** | Pons module | `ponsfamily` contracts + Bitquery API |
| **Optional** | Solana parallel | Fork `moonbags` as separate repo |

---

## 13. What NOT to fork as base

| Repo | Why not as foxhole base |
|------|-------------------------|
| moonbags | Solana/Jupiter — keep as pattern library or parallel Sol repo |
| chainstack pumpfun bot | Python + Solana |
| gmgn-skills | Agent skill layer, not 7×24 runtime |
| 6551 MCP | Signal sidecar, not execution core |
| ponsfamily | Solidity contracts only — integrate via events/API |

**Do fork / own:** `foxhole-bot` — RB-specific discovery + squeeze + (soon) execution.
