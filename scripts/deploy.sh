#!/usr/bin/env bash
# Serialized deploy for the foxhole-bot auto-loops.
#
# Why this exists: several Discord scheduled-task loops (信号复盘 / 仓位复盘 /
# 新闻覆盖 / smart-money) each edit code in THEIR OWN git worktree, then need to
# ship to the live monitor. If two loops push + restart at the same time they
# race on: (a) `git push` non-fast-forward, (b) a double `launchctl kickstart`
# that leaves a phantom second monitor process → duplicate trades
# (the monitor-deploy-duplicate bug). This script funnels every loop's deploy
# through a single flock so those steps can never overlap.
#
# Usage (from inside your loop's worktree, AFTER you've committed locally):
#   bash /Users/xinjuan/git/foxhole-bot/scripts/deploy.sh            # deploys $PWD's HEAD
#   bash /Users/xinjuan/git/foxhole-bot/scripts/deploy.sh /path/to/worktree
#
# Each loop edits ONLY its own worktree and never touches the main checkout's
# working tree, so the `reset --hard` below is always safe (main is a pristine
# deploy tree, mutated only by this script).
set -euo pipefail

MAIN=/Users/xinjuan/git/foxhole-bot
LOCK=/tmp/foxhole-deploy.lock
LABEL=bot.foxhole.monitor
MON_MATCH='tsx src/cli/monitor.ts'
WT="${1:-$PWD}"
UID_NUM="$(id -u)"

log() { echo "[deploy $(date +%H:%M:%S)] $*"; }

# ── Acquire the global deploy lock. Blocks until any other loop's deploy ends. ──
# Portable mutex via atomic mkdir — macOS has no `flock` (util-linux only), which
# silently broke every loop's deploy. Waits up to ~5min, steals a stale lock whose
# owner pid is dead, and always releases on exit.
LOCKDIR="${LOCK}.d"
log "waiting for deploy lock…"
acquired=0
for _ in $(seq 1 300); do
  if mkdir "$LOCKDIR" 2>/dev/null; then acquired=1; break; fi
  owner="$(cat "$LOCKDIR/pid" 2>/dev/null || true)"
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
    log "stale lock (pid $owner dead) — reclaiming"; rm -rf "$LOCKDIR"; continue
  fi
  sleep 1
done
[ "$acquired" -eq 1 ] || { log "ERROR: could not acquire deploy lock after 5min"; exit 1; }
echo "$$" > "$LOCKDIR/pid"
trap 'rm -rf "$LOCKDIR"' EXIT
log "lock acquired; deploying from worktree: $WT"

# ── 1) Push the worktree's committed changes to main, rebasing if another loop
#       pushed first. The lock makes concurrent pushes impossible from OUR loops,
#       but a human push can still land between fetch and push, so keep the retry. ──
cd "$WT"
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "ERROR: worktree has uncommitted changes — commit before deploying"; exit 1
fi
pushed=0
for i in 1 2 3 4 5; do
  if git push origin HEAD:main 2>&1; then pushed=1; break; fi
  log "push rejected (attempt $i), rebasing on origin/main…"
  git fetch -q origin main
  if ! git rebase origin/main; then git rebase --abort || true; fi
  sleep 2
done
if [ "$pushed" -ne 1 ]; then log "ERROR: could not push to main after retries"; exit 1; fi
log "pushed to origin/main"

# ── 2) Sync the pristine deploy checkout. Safe reset: main is never hand-edited. ──
git -C "$MAIN" fetch -q origin main
git -C "$MAIN" reset --hard origin/main
log "main checkout synced to $(git -C "$MAIN" rev-parse --short HEAD)"

# ── 3) Idempotent single-instance restart. Kill any monitor launchd lost track
#       of (the phantom), then let launchd bring up exactly one. ──
log "restarting monitor…"
pkill -f "$MON_MATCH" 2>/dev/null || true
sleep 1
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}"
sleep 3
n="$(pgrep -f "$MON_MATCH" | wc -l | tr -d ' ')"
log "monitor instances now: $n"
if [ "$n" -gt 1 ]; then
  log "WARN: >1 monitor instance detected — killing all and re-kicking once"
  pkill -9 -f "$MON_MATCH" 2>/dev/null || true
  sleep 2
  launchctl kickstart -k "gui/${UID_NUM}/${LABEL}"
  sleep 3
  n="$(pgrep -f "$MON_MATCH" | wc -l | tr -d ' ')"
  log "monitor instances now: $n"
fi
[ "$n" -ge 1 ] || { log "ERROR: monitor not running after restart"; exit 1; }
log "deploy complete ✓"
