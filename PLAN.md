# Foxhole Bot — Missing Pieces Plan

Status audit date: 2026-09-02. Based on README roadmap, REFERENCES.md, and a full read of `src/`.

## Status update (2026-09-02, same day)

Done and pushed to main:
- **1.1 Factory watcher** — real `Created` topic0 verified on-chain
  (`0xadc6f1f7…`, see `src/long/constants.ts` for the decoded layout;
  topic3 = pair stock token). `npm run factory:backfill`, digest alerts in
  the monitor (`LAUNCH_ALERT_MODE`). ~2.6k launches/day observed.
- **1.2 Dashboard** — `web/data/signals.json` written each scan; 锁仓比 +
  信号 columns live.
- **1.3 Monitor hardening** — sequential loop (overlap bug fixed), error
  backoff + health alert, Discord 429 retry, `.env` loader,
  `deploy/bot.foxhole.monitor.plist` (KeepAlive).
- **1.4 Tests + CI** — vitest (34 tests), `.github/workflows/ci.yml`.
- **1.5 Lock trend** — `lock_rising` / `lock_rising_strong` triggers.
- **2.1–2.5 Trading engine** — paper/live modes (`TRADE_MODE`, default off),
  risk gates, JSON position store, hard/trail stops + tiered TPs + stale
  timeout, entries on squeeze triggers, Discord trade alerts + daily P&L,
  `npm run positions`. Live path uses hoodchain `executeSwap` (v3 routing —
  Long v4-only tokens raise `NoRouteError`, surfaced).
- **Bug found by paper trading**: analyzing the HIMS stock token returned
  BONER's stats via the inverted pair → fixed (`selectPrimaryPair` base-side
  check + "• Robinhood Token" filter in discovery).

### Phase 3 findings (Pons reverse-engineering, blocked on credentials)

Probed Pons V2 factory `0x7eD5…ec7e` on mainnet: it's busy (7.6k events/300k
blocks) but none of the frequent events carry launch metadata (no strings, no
token addresses) — topic0 catalog:
- `0x8d4aad49…` ×7659, `0x308c390e…` ×2323 — curve trades (amount-only data)
- `0xcdb72f15…`, `0xa0a18f5b…`, `0x0a44ef75…` ×167 each — per-token trio,
  amounts only (graduation/settlement)
- `0x67d517ee…`/`0x060d1992…` ×7 — batch fee/epoch settlements
Launch discovery therefore needs Bitquery's Pons API (`TokenLaunched`) or
Mobula — both need API keys. 6551 sentiment + GMGN research likewise need
tokens. Next session with credentials: wire Bitquery Pons launches into the
same digest pipeline, add GMGN security check as a pre-entry risk gate.

## What already works (verified in code)

- **Discovery** — `src/long/fetch-launches.ts`: DexScreener search over hardcoded stock queries, stock-paired filter, launch-time backfill, `data/launches.json` + `web/data/launches.json`.
- **Analysis** — `src/long/analyze-token.ts`: quote lock ratio (on-chain balance or DexScreener v4 fallback), stock oracle premium via hoodchain, volume/price signals.
- **Signal engine** — `src/signals/`: 5-level scoring (lock tiers, volume spike/accel, momentum, BONER composite, premium), tunable config.
- **Backtest** — `src/backtest/`: real DexPaprika OHLCV walk-forward replay, 3 pump + 3 control fixtures, pass/fail on alert-before-peak.
- **Monitor** — `src/monitor/`: scan loop, per-token state, cooldown + level-upgrade dedup, Discord webhook alerts.
- **Dashboard** — `web/index.html` served via deploy script + Caddy at long.foxhole.bot; launchd plist redeploys at load.

---

## Phase 1 — finish Monitor (highest priority)

### 1.1 Long Factory `Created` event watcher  *(README: unchecked)*
Discovery today depends on the hardcoded `SEARCH_QUERIES` / `STOCK_QUOTES` lists in `src/long/constants.ts` — any launch paired with a stock symbol not in the list is invisible until someone edits constants.
- Add `src/long/watch-factory.ts`: viem `watchContractEvent` / `getLogs` on Factory `0x22e9…eeed` `Created` event (constant already defined as `LONG_CREATED_EVENT`).
- Need the Created event ABI (Mobula Long.xyz docs in REFERENCES §3 have Factory/Airlock ABI).
- On event: resolve token + quote, merge into `launches.json`, run `analyzeToken`, emit a `launch_watch` alert immediately (launch-snipe radar).
- Backfill mode: `getLogs` from factory deploy block to seed the full launch list independent of DexScreener search (removes the hardcoded-symbol blind spot).
- Fold into monitor loop so new launches are caught between DexScreener refreshes.

### 1.2 Dashboard: lock ratio + signal columns  *(README: unchecked)*
Scan results never reach the web dashboard.
- After each scan, write `web/data/signals.json` (per-token: lock ratio, level, score, triggers, updatedAt).
- Add columns to `web/index.html`: 锁仓比 (lock ratio), 信号 (signal level badge), score; sortable like existing columns.
- Optional: alert history feed section on the page.

### 1.3 Monitor runtime hardening
- **Overlap bug**: `runMonitorLoop` uses `setInterval` without awaiting the previous tick — a slow scan (many tokens × 250 ms sleep + RPC calls) can overlap the next one and double-alert. Switch to a `while(true) { await tick(); await sleep(interval) }` loop.
- **No service for the monitor**: the existing plist only redeploys the static dashboard (`RunAtLoad`, `KeepAlive false`). Add `deploy/bot.foxhole.monitor.plist` with `KeepAlive true` running `npm run monitor`, logs to `~/preview/logs/foxhole-monitor.log`.
- **Dashboard freshness**: data refreshes only on deploy. Either let the monitor loop rewrite `web/data/*` each tick (it already calls `collectLaunches`) or add `StartInterval` to the deploy plist.
- Error backoff on repeated DexScreener/RPC failures; startup + failure notifications to Discord.
- Discord client: handle 429 rate limits (retry-after), optionally upgrade to embeds with color per level.

### 1.4 Tests + CI (nothing exists today)
- Add vitest: unit tests for `evaluateSignal` threshold edges, `monitor/state` cooldown/upgrade logic, `analysisToSignalInput` mapping, launch merge/dedup.
- `.github/workflows/ci.yml`: `npm run typecheck` + tests on push (repo currently has no `.github`).
- Keep `npm run backtest` as the integration gate; consider caching OHLCV fixtures to JSON so backtest runs offline/deterministic in CI.

### 1.5 Signal-quality follow-ups
- Lock-ratio history: persist per-scan lock ratio in monitor state so we can alert on *rising* lock (BONER pattern is the trend, not the level) — add `lockDeltaRatio` trigger.
- Grow backtest fixtures as new pumps/controls happen; recalibrate `SIGNAL_CONFIG` when a fixture fails.
- Auto-resolve DexPaprika poolIds (currently hardcoded per fixture).

---

## Phase 2 — Auto-trading on hoodchain (README: all unchecked)

Reference: `robinhood-chain-trading-bot` (risk caps, paper mode), `moonbags` (exit management).

### 2.1 Wallet + swap execution
- `src/trade/wallet.ts`: signer from `TRADER_PRIVATE_KEY` env (add to `.env.example` with loud warnings); balance guards.
- `src/trade/swap.ts`: hoodchain quote → build → sign → send; slippage cap; confirm receipt; retry policy.

### 2.2 Risk engine (before any live order)
- `src/trade/risk.ts`: max USD per trade, max open positions, daily spend cap, per-token allow/deny list, min-liquidity gate.
- **Paper mode default** (`TRADE_MODE=paper|live`): identical pipeline, simulated fills at quote price, logged to the same position store.

### 2.3 Position tracker + exits
- `src/trade/positions.ts`: persistent store (JSON first, SQLite if needed) — entry, size, cost basis, high-water mark.
- Exit engine (moonbags patterns): trailing stop from high-water mark, hard stop-loss, tiered take-profit, time-based exit for dead launches.
- Exit checks run inside the monitor tick against live prices.

### 2.4 Entry wiring
- Map signal triggers to entries: `launch_watch` → small snipe size; `lock_strong`/`boner_composite` → squeeze entry; all gated by risk engine.
- Every entry/exit posts to Discord with P&L.

### 2.5 Reporting
- Daily P&L summary to Discord; positions table on the dashboard (paper first).
- Optional later: LLM exit advisor (claude-api skill patterns).

**Gate**: run paper mode ≥2 weeks with backtest-passing config before enabling `live`.

---

## Phase 3 — Multi-signal (README: all unchecked)

1. **Pons module** — `src/pons/`: V2 factory `0x7eD5…ec7e` + MemeHook events (ponsfamily contracts, Bitquery Pons API); reuse signal engine with launchpad tag.
2. **6551 sentiment sidecar** — opennews-mcp `get_news_by_engine(engine_type="meme")` + Twitter watchlist for Long.xyz KOLs; feed as score modifier, not standalone trigger.
3. **GMGN RB research** — hoodly-gmgn-robinhood-mcp (needs `GMGN_API_KEY`): token security/holder checks as pre-entry rug filter for Phase 2.
4. **OKX smart money** — only if RB chain coverage materializes; lowest priority.

---

## Housekeeping (small, do alongside Phase 1)

- `.env.example`: add `TRADE_MODE`, `TRADER_PRIVATE_KEY` (phase 2), `GMGN_API_KEY` (phase 3) placeholders when each lands.
- README: keep roadmap checkboxes honest as items complete; document monitor launchd install.
- `data/monitor-state.json` should be in `.gitignore` (verify).
- Deploy plist hardcodes `/Users/xinjuan/git/foxhole-bot` — fine for the main checkout, but note worktree runs won't match.

## Suggested execution order

| # | Item | Size |
|---|------|------|
| 1 | Monitor overlap fix + monitor launchd plist (1.3) | S |
| 2 | Factory `Created` watcher + backfill (1.1) | M |
| 3 | Dashboard signals.json + lock column (1.2) | S–M |
| 4 | Vitest + CI (1.4) | S–M |
| 5 | Lock-ratio trend trigger + fixture growth (1.5) | S |
| 6 | Paper-mode trade pipeline: wallet/swap/risk/positions (2.1–2.3) | L |
| 7 | Entry wiring + P&L reports (2.4–2.5) | M |
| 8 | Live-mode gate review | — |
| 9 | Pons module, then sentiment/GMGN sidecars (3.x) | M each |
