# Foxhole Multi-Chain Plan — Solana, BSC, Base, ETH

## STATUS (2026-09-02, same day): P0–P5 SHIPPED

All six phases plus most §7b parity gaps are implemented and live-verified —
see README roadmap and git history (P0 `15914b3` … grid search `1adbdec`).
Gap items done: fast position tick (1), advisor evidence (3), positions
dashboard (4), grid search (5), price-feed redundancy (6). Still open:
- Interactive Discord control (gap 2) — needs a DISCORD_BOT_TOKEN
- External signal intake (gap 7) — needs GMGN/OKX/6551 keys
- Per-chain backtest fixtures — machinery is multi-chain-ready
  (DexScreener pairAddress works as a DexPaprika pool id); fixtures
  accumulate as real pumps/controls are observed
- ≥2-week clean paper run per chain before any live mode
- Live execution paths (BSC/Base/Solana/RB) untested with real funds

Drafted 2026-09-02. Extends foxhole-bot beyond Robinhood Chain with the same
three pillars per chain: **triggering** (launch + trend discovery),
**analysis** (signals), **execution** (paper → live).

Facts verified today: DexScreener free API returns solana/bsc/base/ethereum
pairs; Jupiter `lite-api.jup.ag` quotes work keyless; PumpPortal WS
(`subscribeNewToken`/`subscribeMigration`) is free-tier but needs an API key +
0.02 SOL linked wallet; Four.meme trading runs through TokenManager2
`0x5c952063c7fc8610FFDB798152D69F0B9550762b` on BSC (56); `clanker-sdk` is
deploy-only (no discovery), viem-based.

---

## 1. Architecture: chain adapters over the existing core

What we already have is mostly chain-agnostic and stays as the shared core:

| Shared core (keep) | Chain-specific (new adapters) |
|---|---|
| Signal engine (volume spike/accel, momentum, launch watch) | Launch event watchers per launchpad |
| Monitor loop, alert state + cooldowns, Discord | Chain-specific signals (curve progress, migrations) |
| Trading engine: risk gates, position store, stops/TPs, LLM advisor | Live execution (router/aggregator per chain) |
| Dashboard, backtest replay (DexPaprika is multi-network) | Wallets + gas handling |

New layout:

```
src/
├── chains/
│   ├── adapter.ts        # ChainAdapter interface + registry
│   ├── robinhood/        # wrap existing long/ + hoodchain (refactor target)
│   ├── solana/           # pump.fun/bonk.fun stack
│   ├── evm/              # shared EVM toolkit (viem): log watcher, erc20, routers, safety
│   ├── bsc/              # Four.meme on top of evm/
│   ├── base/             # Clanker on top of evm/
│   └── ethereum/         # Uniswap new-pair monitor on top of evm/
```

```ts
interface ChainAdapter {
  id: "robinhood" | "solana" | "bsc" | "base" | "ethereum";
  // Triggering: launch/migration events + trending candidates
  discoverLaunches(sinceCursor): Promise<{ launches, cursor }>;
  trendingCandidates(): Promise<CandidateToken[]>;      // DexScreener-backed
  // Analysis: generic market analysis + chain-specific extras
  analyze(token): Promise<TokenAnalysis>;               // adds `extras` map
  priceUsd(token): Promise<number | undefined>;
  // Execution: live path only — paper fills stay in the shared engine
  buy(token, usd, cfg): Promise<TradeFill>;
  sell(token, amount, cfg): Promise<TradeFill>;
}
```

Enabled chains come from env: `CHAINS=robinhood,solana,bsc,base` — each chain
opt-in, each with its own wallet key and spend caps. The monitor loop iterates
enabled adapters; alert state and positions gain a `chain` field.

Refactors required (do first, no behavior change):
- Split `analyzeToken` into generic DexScreener analysis (any chain) + a
  Robinhood extras hook (lock ratio, oracle premium).
- `SignalInput.isStockPaired`/lock fields become part of an `extras` bag the
  engine reads when present; core triggers (volume/momentum/launch) untouched.
- Positions/risk: add `chain`, per-chain daily caps + global cap.

## 2. Data layer (all free / keyless)

| Source | Chains | Use |
|---|---|---|
| DexScreener `latest/dex/*` | all 5 ✅ verified | prices, volume, pairs, search |
| DexScreener `token-profiles` / `token-boosts` | all | trending/promoted discovery |
| DexPaprika OHLCV | multi-network | backtests per chain (verify slugs at impl) |
| Chain RPCs | free public per chain | events, holders, safety reads |
| GoPlus security API | BSC/Base/ETH (+SOL) | honeypot/tax/rug flags — keyless basic tier (verify at impl) |
| GMGN / OKX / Bitquery | all | optional enrichment once keys exist |

## 3. Per-chain modules

### 3.1 Solana — pump.fun / bonk.fun (largest new stack)

- **Triggering** (two options, build A first):
  - A. Key-free: RPC `logsSubscribe` on the pump.fun program
    (`6EF8…wF6P`) via public mainnet WS; decode create/complete instructions.
    Helius free tier as drop-in upgrade when rate-limited.
  - B. PumpPortal WS `subscribeNewToken` + `subscribeMigration` (free tier;
    needs key + 0.02 SOL linked wallet) — simpler payloads, use if the user
    provisions a key.
- **Analysis**: bonding-curve progress + velocity (graduation %), dev-wallet
  hold/sell behavior, top-10 holder concentration (RPC `getTokenLargestAccounts`),
  post-graduation volume/momentum via DexScreener. **Migration = strong
  trigger** (pump.fun → Raydium/PumpSwap is the SOL analogue of our
  boner_composite moment).
- **Execution**: graduated tokens via Jupiter lite-api (quote ✅ verified +
  swap → signed with local keypair); pre-graduation buys via the bonding
  curve (PumpPortal trade-local returns a serialized tx, or direct ix —
  borrow curve math from `chainstacklabs/pumpfun-bonkfun-bot`).
- **Borrow from**: chainstacklabs bot (filter pipeline, listener architecture),
  moonbags (exit patterns — already ported to our engine).
- **Deps**: `@solana/web3.js` only. Separate `SOLANA_PRIVATE_KEY`.

### 3.2 BSC — Four.meme

- **Triggering**: event watcher on TokenManager2
  `0x5c95…762b` (TokenCreate, buys/sells, **migration to PancakeSwap**) —
  reuse our chunked `getLogs` watcher pattern from the Long factory, free
  public BSC RPCs.
- **Analysis**: curve progress, migration event as graduation trigger,
  standard engine signals from DexScreener.
- **Execution**: pre-migration buy/sell via TokenManager (port curve math
  from `@fnzero/four-trading-sdk` — it's ethers-based, we're viem; use it as
  reference, not dependency); post-migration via PancakeSwap v2 router.

### 3.3 Base — Clanker

- **Triggering**: Clanker factory event watcher (resolve current v4 factory
  address at impl; `clanker-sdk` deploys only, so we watch events ourselves)
  + DexScreener token-boosts trending for non-Clanker Base memes.
- **Analysis**: standard engine + deployer-history rug heuristic (has this
  creator's prior token rugged — needs light local indexing or GMGN later).
- **Execution**: Uniswap v3/universal router via viem, WETH-paired.

### 3.4 ETH mainnet — honest scoping

Fresh-pair sniping on ETH is rug-dominated and gas-expensive. Start
**monitor-only**: Uniswap v2 `PairCreated` / v3 `PoolCreated` watcher with
strict liquidity/volume floors, alerts on established momentum (our accel
triggers), GoPlus safety gate. Enable execution (Uniswap router) only after
the monitor proves signal quality. Lowest priority.

### 3.5 Shared EVM toolkit (`chains/evm/`)

Used by BSC/Base/ETH (Robinhood migrates onto it later):
- per-chain viem clients + chain configs (RPC, router, WETH, explorer)
- generalized chunked log watcher (extract from `factory-watcher.ts`)
- ERC-20 reads, v2-router and v3-router swap modules with slippage caps
- safety module: GoPlus lookup + buy/sell simulation via `eth_call`
  (honeypot/tax detection) as a mandatory pre-entry risk gate

## 4. Signals: what generalizes, what's new

- Universal (already built): volume spike vs peers, volume acceleration,
  price momentum, launch-watch window, liquidity floor.
- Robinhood-only (stays an extra): quote lock ratio, oracle premium.
- New universal triggers: `graduation` (pump.fun/Four.meme migration —
  strong), `curve_velocity` (bonding-curve progress accelerating),
  `trending_boost` (DexScreener boosts), plus a `holder_concentration` and
  `safety_flags` *veto* gate (blocks entries rather than scoring).
- Backtest: extend the DexPaprika replay to each new chain's pools; per-chain
  pump/control fixtures before any live mode.

## 5. Wallets, risk, ops

- One wallet per chain (`{CHAIN}_PRIVATE_KEY`), never shared, funded with
  loss-tolerable amounts only. Paper mode is the default on every chain; the
  ≥2-week clean-paper gate applies **per chain**.
- Risk engine gains per-chain caps + a global daily cap; safety-gate failures
  are hard vetoes. Positions/dashboard/P&L grouped by chain.
- Monitor: one process, staggered per-chain tick intervals (SOL launch flow
  is ~10-100× Robinhood's; digests already handle volume).

## 6. Phasing

| # | Phase | Contents | Size |
|---|-------|----------|------|
| P0 | Adapter refactor + multi-chain monitor | `chains/` registry, generic analysis split, DexScreener trending/momentum alerts for all 4 new chains (no new execution) | M |
| P1 | EVM toolkit + BSC | log watcher generalization, Four.meme watcher + curve analysis, Pancake execution, paper mode | M |
| P2 | Base | Clanker watcher, Uniswap execution, paper mode | M |
| P3 | Solana | logsSubscribe discovery, curve analysis, Jupiter + curve execution, paper mode | L |
| P4 | ETH monitor-only | Uniswap pair watcher + strict floors | S |
| P5 | Safety + backtests | GoPlus/honeypot gates on all EVM entries, per-chain fixtures, live-mode reviews | M |

P0 pays off immediately (alerts for all four chains through the existing
engine) and de-risks everything after it.

## 7. Code reuse & license audit (checked 2026-09-02)

| Repo | License | Maintenance (checked 2026-09-02) | Reuse verdict |
|---|---|---|---|
| chainstacklabs/pumpfun-bonkfun-bot | Apache-2.0 ✅ | Active, ~970 stars | **Vendor the pump.fun IDLs** (`idl/pump*.json`), port curve math + discriminators + logsSubscribe listener to TS, with attribution |
| @fnzero/four-trading-sdk | MIT ✅ | ⚠️ stale: last publish 2025-10, 46 dl/mo, 5 versions | **Vendor/port the curve math + event decoding to viem** — do NOT take as a runtime dependency (abandonment + supply-chain risk, and it drags in ethers) |
| clanker-sdk | MIT ✅ | Healthy: publish 2026-08-31, 52k dl/mo, 119 versions | Still prefer **mining v3/v4 modules for Base factory addresses + ABIs** over a runtime dep — we need constants, not its deploy machinery |
| meme-sdk/fourmeme-trading | — | **404 — repo deleted** | Gone; reinforces vendor-don't-depend for meme-repo code |
| moonbags | **Private — no redistribution** ⛔ | n/a | Patterns only (already done: our stops/TPs/LLM advisor were written from scratch). Never copy code |
| hoodchain | Apache-2.0 ✅ | Small (2 versions, 217 dl/mo) but it IS the RB SDK | Keep as dependency, **pin exact version** |
| @solana/web3.js | MIT ✅ | 9.4M dl/mo, publish 2026-09-01 | Safe dependency (1.x line; ecosystem/pump.fun examples target it). Note: it was supply-chain-compromised once (Dec 2024) — pin + lockfile |
| GMGN/OKX skills, 6551 MCPs | n/a | n/a | API-key-gated services, not code |

**Second survey round (2026-09-02, wider sweep — changed the Solana plan):**

| Package | License | Maintenance | Verdict |
|---|---|---|---|
| **@pump-fun/pump-sdk** (official) | MIT | v1.36.0, 130 releases, 71k dl/mo, publish 2026-05 | **Pinned dep — replaces porting Python curve math.** Official instruction builders for create/curve-trade/AMM. chainstacklabs repo demoted to listener/filter architecture reference |
| **@jup-ag/api** (official Jupiter) | MIT | 260k dl/mo, publish 2026-08 | **Pinned dep** for graduated-token execution |
| **@goplus/sdk-node** (official GoPlus) | Apache-2.0 | 30k dl/mo, publish 2026-08 | **Pinned dep** for the EVM safety gate (P5) |
| @triton-one/yellowstone-grpc | Apache-2.0 | active, publish 2026-08 | Optional fast-listener upgrade (needs paid Geyser endpoint) — not needed for signal-based entries |
| @pancakeswap/sdk / @uniswap/sdk-core | MIT | active | Available; direct viem router calls likely suffice — decide at impl |
| pumpdotfun-sdk (community) | ISC | stale (2025-03) | Skip — superseded by official SDK |
| bitquery/sniper-bot-bsc | — | active | Bitquery-Kafka-gated; reference only. **No well-maintained Four.meme SDK exists** — fnzero vendor/port verdict stands |

**Dependency policy for this repo** (we hold private keys — crypto npm is a
top supply-chain target): big actively-maintained libs (viem, @solana/web3.js,
official pump-sdk/jup-ag/goplus, @anthropic-ai/sdk) as **pinned exact
versions** with lockfile; small/stale/hobby packages get vendored (license +
attribution header) instead of installed; `npm ci` only in CI; review diffs on
upgrades; no packages with postinstall scripts.

## 7b. Moonbags parity gaps (patterns to rebuild — its license forbids copying)

Capabilities moonbags has that foxhole-bot currently lacks; all are
chain-agnostic engineering we build ourselves:

1. **Fast position tick** — moonbags checks open positions every 3s; our
   single 5-min loop is far too slow for meme trailing stops. Split the
   monitor: discovery stays at 5 min, a dedicated 10–15s loop prices open
   positions and runs exits. **Do this in P0 — it matters even for
   Robinhood-only paper trading today.**
2. **Interactive control** — we only push one-way webhooks. Add a discord.js
   bot (we live in Discord, not Telegram): `/positions`, `/sellall`,
   per-position sell buttons, pause/resume trading.
3. **Richer LLM advisor evidence** — moonbags feeds its advisor smart-money
   flow, dev holdings, klines; ours currently gets little beyond price.
   Cheap immediate fix: populate the advisor context we already defined
   (lock ratio, volume, momentum) from the scan; later add holder data.
4. **Positions on the dashboard** — write `web/data/positions.json` and add
   a P&L view next to launches/signals.
5. **Backtest grid search** — sweep SIGNAL_CONFIG / exit params against the
   fixture set instead of hand-tuning.
6. **Price-feed redundancy** — DexScreener-only today; add DexPaprika (and
   Jupiter on SOL) as fallback so one API outage doesn't blind stops.
7. **External signal intake** (OKX WS / GMGN feeds) — already planned as
   Phase 3, key-gated.

## 7c. Borrow map — top-down, by capability

Legend: **[dep]** pinned npm dependency · **[vendor]** copy into repo with
attribution · **[pattern]** rebuild the idea (license/language forbids copy) ·
**[api]** hosted service, no code.

### Triggering (launch + trend discovery)
- All chains
  - [api] DexScreener — search, token-profiles/boosts trending
  - [pattern] chainstacklabs bot — staged filter pipeline, per-strategy configs
- Solana (pump.fun)
  - [dep] @pump-fun/pump-sdk — program IDs, event layouts, graduation detection
  - [pattern] chainstacklabs bot — listener fallback chain, launch filters
  - [vendor] its IDL JSONs — only if the official SDK misses an account type
  - [api] PumpPortal WS — subscribeNewToken/subscribeMigration (optional)
- BSC (Four.meme)
  - [vendor] @fnzero/four-trading-sdk — TokenManager addresses, event decoding
  - [pattern] bitquery/sniper-bot-bsc — launch-detect → entry flow shape
- Base (Clanker)
  - [vendor] clanker-sdk v3/v4 — factory addresses + ABIs
  - [pattern] gmgn-skills trenches — dev-history/bundler filter concepts
- ETH — own generalized EVM watcher; nothing worth borrowing

### Analysis (signals)
- ours (built): volume spike/accel, momentum, launch-watch, lock ratio + trend
- [pattern] robinhood-volume-alerts — learned volume baseline vs static ratios
- [pattern] OKX copy-trade plugin — 15-point safety checklist, consensus entry
- [pattern] OKX trench scanner — TX-acceleration signal
- [dep] @pump-fun/pump-sdk — curve progress/velocity math
- [vendor] fnzero — Four.meme curve progress math
- [dep] @goplus/sdk-node — honeypot/tax/holder flags (EVM)
- [api, keys] GMGN / hoodly MCPs — security, smart money
- [api, keys] 6551 opennews — meme sentiment as score modifier

### Alerting + control
- ours (built): webhooks, digests, cooldowns, level-upgrade dedup
- [pattern] robinhood-chain-alert-bot — alert taxonomy + severity routing
- [pattern] robinhood-toolkit — /healthz, severity → channel routing
- [pattern] moonbags — interactive control (/positions, /sellall, sell
  buttons) rebuilt on [dep] discord.js
- [pattern] moonbags — positions/P&L dashboard view

### Execution
- Robinhood: [dep] hoodchain (done)
- Solana: [dep] @pump-fun/pump-sdk (curve) + [dep] @jup-ag/api (graduated);
  [pattern] pumpfun-pumpswap-sdk auto-routing by graduation state;
  [pattern] Jito bundle submission (only if 0-block ever in scope)
- BSC: [vendor] fnzero tx construction → viem; Pancake v2 router via viem
- Base/ETH: direct viem router; [dep] @uniswap/sdk-core / @pancakeswap/sdk
  only if routing math demands it
- [pattern] moonbags jupClient — retry/slippage/priority-fee shape
- [pattern] robinhood-chain-trading-bot — paper/live pipeline parity

### Risk, positions, exits
- ours (built): caps, limits, hard/trail stops, tiered TPs, stale exit, advisor
- [pattern] moonbags — 3s fast position tick; evidence-gated advisor
- [pattern] OKX copy-trade — 7-layer exit ladder ideas
- [pattern] robinhood-chain-trading-bot — P&L accounting/dashboard

### Backtesting + tuning
- ours (built): DexPaprika walk-forward replay, pump/control fixtures
- [pattern] moonbags — parameter grid search
- [pattern] chainstacklabs — per-strategy config variants for A/B runs

### Data + infra
- [dep] viem, @solana/web3.js, @anthropic-ai/sdk, discord.js (pinned exact)
- [dep, optional] @triton-one/yellowstone-grpc — fast SOL listening
- [api] DexScreener, DexPaprika, Jupiter lite-api, public RPCs, GoPlus
- [pattern] robinhood-chain-kit — SQLite indexer + multicall batching when
  JSON state stops scaling

## 8. Needs from the user (none block P0–P4)

- Nice-to-have keys: Helius (SOL rate limits), PumpPortal (0.02 SOL),
  GoPlus if the keyless tier proves limited, GMGN/OKX for enrichment.
- Decide which chain goes live-trading first (recommendation: BSC or Base —
  EVM execution is simplest and closest to what's already proven).
