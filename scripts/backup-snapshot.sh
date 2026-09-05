#!/bin/bash
# Periodic-snapshot backup of the SQLite DB — the simple alternative to
# litestream (coarser: you lose up to one interval on disaster). Schedule it
# (launchd / cron) e.g. hourly. Consistent even while the monitor is writing
# because it uses SQLite's online .backup, never a raw cp of the live WAL db.
#
# Configure via env (put these in .env or the launchd job, NOT in git):
#   BACKUP_TARGET   e.g. oss://my-foxhole-backup/foxhole   (Aliyun, via ossutil)
#              or   e.g. s3://my-foxhole-backup/foxhole    (AWS, via aws cli)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${FOXHOLE_DB_PATH:-$ROOT/data/foxhole.db}"
TARGET="${BACKUP_TARGET:-}"
[ -z "$TARGET" ] && { echo "BACKUP_TARGET unset — nothing to do"; exit 0; }

tmp="$(mktemp -t foxhole-backup.XXXXXX).db"
trap 'rm -f "$tmp"' EXIT
sqlite3 "$DB" ".backup '$tmp'"                     # consistent online snapshot
stamp="$(date +%F-%H%M)"

case "$TARGET" in
  oss://*) ossutil cp -f "$tmp" "$TARGET/foxhole-$stamp.db" ;;
  s3://*)  aws s3 cp "$tmp" "$TARGET/foxhole-$stamp.db" ;;
  *)       echo "unknown BACKUP_TARGET scheme: $TARGET"; exit 1 ;;
esac
echo "backed up $DB → $TARGET/foxhole-$stamp.db"
