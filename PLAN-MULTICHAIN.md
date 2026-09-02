# Foxhole Multi-Chain Plan — Solana, BSC, Base, ETH

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

**Dependency policy for this repo** (we hold private keys — crypto npm is a
top supply-chain target): big actively-maintained libs (viem, @solana/web3.js,
@anthropic-ai/sdk) as pinned dependencies with lockfile; small/stale/hobby
packages get vendored (license + attribution header) instead of installed;
`npm ci` only in CI; review diffs on upgrades; no packages with postinstall
scripts.

## 8. Needs from the user (none block P0–P4)

- Nice-to-have keys: Helius (SOL rate limits), PumpPortal (0.02 SOL),
  GoPlus if the keyless tier proves limited, GMGN/OKX for enrichment.
- Decide which chain goes live-trading first (recommendation: BSC or Base —
  EVM execution is simplest and closest to what's already proven).
