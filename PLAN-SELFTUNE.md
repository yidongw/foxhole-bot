# PLAN-SELFTUNE — Daily Self-Review & Auto-Tuning Loop

Drafted 2026-09-02. Goal: every 24h the bot grades its own alerts (did they
pump? → reinforce), hunts for 暴涨 tokens it missed, diagnoses both failure
modes, proposes a strategy revision, backtests it against the full case
library, and auto-applies it only if it captures the misses **without**
re-admitting the false alerts.

## Design principles (read first)

1. **Tuning is config-as-data, never code.** The tuner searches a bounded
   parameter space and writes `data/signal-overrides.json` (merged over
   `SIGNAL_CONFIG` at runtime). Auto-push commits JSON — reviewable,
   one-file revert. The LLM analyzes and *recommends* code-level ideas in
   the daily report; it never edits code automatically.
2. **Two failure modes need two different fixes.**
   - *Threshold miss*: token was scanned but thresholds blocked the alert →
     the tuner can fix this.
   - *Coverage miss*: token was never scanned at all (trending list is only
     ~30 tokens/chain) → no threshold change can help; fixed structurally by
     adding a **top-movers discovery feed** (part of this feature, R2).
   The review must classify every miss into one of these — otherwise the
   tuner chases problems it cannot solve.
3. **Every graded day becomes a permanent case.** Wins become regression
   fixtures (a future config that would have missed a past win is rejected —
   that *is* the positive reinforcement, made mechanical). False alerts
   become control cases. Misses become pump cases. The library only grows.
4. **Anti-overfit guards.** One day of meme data is noise: tuner activates
   only once the library has ≥5 labeled cases; changes ≤1 grid-step per
   parameter per day; adopt only if *strictly* better on the whole library;
   never regress the 11 base fixtures.

## R1 — Alert outcome ledger (grade our own alerts)

- At scan time, every ≥alert evaluation appends a structured record to
  `data/outcomes/pending.json`: chain, address, symbol, time, level, score,
  triggers, priceUsd, volume, liquidity, poolId (DexScreener pairAddress).
- The daily review grades records older than 24h using **1h OHLCV since the
  alert** (DexPaprika, verified: pairAddress works as pool id):
  - **WIN**: max high ≥ +40% above alert price (catches pump-and-fade that a
    spot check would miss)
  - **FLAT**: never ±; **LOSS/false alert**: ≤ −30% without a +40% first
- Graded records move to `data/outcomes/labeled.json` (append-only library).
- Reinforcement: wins celebrated in the report with returns
  ("✅ BONER +214% after lock_strong") and converted to pump cases;
  losses carry their full trigger breakdown for diagnosis.

## R2 — Missed-暴涨 scan + coverage fix

- Per chain, fetch **top ~100 pools by `volume_usd_24h`** from DexPaprika
  `pools/search` (verified working; do NOT sort by price change — that
  surfaces broken pools with 10^10% moves), then filter:
  `price_change_24h ≥ +100%`, `< 10,000%` (garbage cap), liquidity ≥ $30k,
  exclude wrapped natives/stables/majors.
- Classify each mover:
  - **ALERTED** — in the ledger before/during the rise → win, credit it
  - **THRESHOLD MISS** — present in monitor state (was scanned) but never
    reached alert → tuner input
  - **COVERAGE MISS** — never scanned → discovery input
- Persist misses as pump cases (fetch their 1h OHLCV window at grade time).
- **Structural fix shipped with R2**: the movers list becomes an additional
  `trendingCandidates` source for the regular 5-min scan, so coverage
  misses shrink at the source from day one.

## R3 — Bounded auto-tuner with acceptance gates

- `loadSignalConfig()` = `SIGNAL_CONFIG` + `data/signal-overrides.json`
  (all signal/evaluate callers switch to it).
- Replay harness extension: hourly-candle support for fresh cases (rolling
  24h volume window sampled hourly; same walk-forward logic). Old daily
  fixtures unchanged.
- Search space: current grid dims + `minVolumeUsd`, `volumeSpike*`,
  `curveNear*` — each parameter may move at most one step from the current
  value per day.
- **Acceptance (all required):**
  a. all 11 base fixtures still pass
  b. every past WIN case still alerts (reinforcement as regression guard)
  c. ≥1 previously-missed pump case now alerts
  d. no labeled false-alert case that current config avoids becomes an alert
  e. net score strictly better (captures − new false alerts)
- If no candidate passes: **no change**, and the report says explicitly
  "today's misses are not threshold-fixable" with the per-case gate that
  blocked each one (this is the signal that a *new trigger* is needed —
  a human/LLM design task, not auto-tunable).

## R4 — LLM analysis + daily report

- Claude (existing `ANTHROPIC_API_KEY` gate, same as exit advisor) receives
  the structured day: wins with returns, false alerts with trigger
  breakdowns and post-alert price paths, misses with classification and
  blocking gates, tuner decision + evidence. It writes the narrative: *why*
  the false alerts fired, *why* the misses were missed, and concrete
  recommendations (including new-trigger ideas the tuner can't reach).
- Output: Discord report + `web/data/review.json` (dashboard card later).
- Without an API key the loop still runs — mechanical stats + tuner, no
  narrative.

## R5 — 24h loop + gated auto-push

- Runs inside the monitor process (`state.lastReviewAt`, 24h cadence) +
  `npm run review` for manual runs. No new infra.
- **Auto-push** (only when `AUTO_TUNE_PUSH=1`): if the tuner adopted a
  change, commit `data/signal-overrides.json` + the updated case library +
  any new fixtures, push to main with an evidence-bearing commit message.
  Default off → apply locally + report only. Revert = delete the overrides
  file (or `git revert` one JSON commit).
- Every adopted change announces itself in Discord with before/after config
  and the cases that justified it.

## Build order

| # | Slice | Contents | Size |
|---|-------|----------|------|
| 1 | Ledger | structured alert records + 1h-OHLCV grading + labeled library | M |
| 2 | Movers | top-movers scan, miss classification, movers discovery feed | M |
| 3 | Config-as-data | loadSignalConfig + overrides file + hourly replay support | M |
| 4 | Tuner | bounded search + acceptance gates + case-library replay | M |
| 5 | Review job | 24h loop, Discord report, LLM narrative, `npm run review` | S–M |
| 6 | Auto-push | gated git commit/push of overrides + library | S |

## Known limitations (stated up front)

- Grading needs the pool still indexed 24h later — fully rugged tokens may
  lack candles; grade those LOSS by definition (price effectively −100%).
- The tuner optimizes thresholds only; genuinely new signal *types* (e.g.
  holder-flow, smart-money inflow) surface as recommendations, not auto-code.
- Meme regimes shift; the one-step-per-day bound means the config trails
  fast regime changes by design — that's the price of not thrashing.
- Auto-push runs on whatever machine hosts the monitor and needs git
  credentials there; report-only mode has no such requirement.
