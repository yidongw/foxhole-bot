#!/bin/bash
# Deploy foxhole-bot dashboard to https://long.foxhole.bot
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${FOXHOLE_BOT_PORT:-8877}"
HOST="long.foxhole.bot"
ROUTE_ID="foxhole-bot-long"
LOG_DIR="${HOME}/preview/logs"
PID_FILE="${LOG_DIR}/foxhole-bot.pid"
LOG_FILE="${LOG_DIR}/foxhole-bot.log"

mkdir -p "$LOG_DIR"

echo "▶ refreshing Long.xyz data (TypeScript)…"
cd "$ROOT"
npm run fetch:long

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "▶ stopping existing foxhole-bot server (pid $(cat "$PID_FILE"))…"
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  sleep 0.5
fi

echo "▶ starting static server on :${PORT}…"
nohup python3 -m http.server "$PORT" --directory "$ROOT/web" >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"

for _ in $(seq 1 20); do
  if curl -sf "http://localhost:${PORT}/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

echo "▶ registering Caddy route ${HOST} → localhost:${PORT}…"
curl -sf -X DELETE "http://localhost:2019/id/${ROUTE_ID}" 2>/dev/null || true
curl -sf -X POST "http://localhost:2019/config/apps/http/servers/preview/routes" \
  -H "Content-Type: application/json" \
  -d "{
    \"@id\": \"${ROUTE_ID}\",
    \"match\": [{\"host\": [\"${HOST}\"]}],
    \"handle\": [{\"handler\": \"reverse_proxy\", \"upstreams\": [{\"dial\": \"localhost:${PORT}\"}]}]
  }"

echo "✓ live: https://${HOST}"
echo "  local: http://localhost:${PORT}"
echo "  logs:  ${LOG_FILE}"
