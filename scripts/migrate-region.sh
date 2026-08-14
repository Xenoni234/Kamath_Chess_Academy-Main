#!/usr/bin/env bash
#
# Move the KCA database to a new Supabase region (Tokyo -> Mumbai).
#
# Why: the app is used from India but the database sits in ap-northeast-1, so
# every query pays a ~150 ms round trip. ap-south-1 brings that to ~20-30 ms.
#
# What this does NOT do, on purpose:
#   - It does not create the Supabase project. Do that yourself in the
#     dashboard; only you should be handling those credentials.
#   - It does not edit .env.local. You swap that over once you are satisfied.
#   - It does not touch the old database. Keep Tokyo alive until Mumbai is
#     verified and running in production for a few days.
#
# Usage:
#   ./scripts/migrate-region.sh 'postgresql://postgres:PASS@db.NEW.supabase.co:5432/postgres'
#
# Pass the NEW project's DIRECT (session, port 5432) URL, not the pooled 6543
# one — pg_restore needs a real session, and the pooler will break it.

set -euo pipefail

NEW_DIRECT_URL="${1:-}"
DUMP_FILE="${DUMP_FILE:-/tmp/kca-migration-$(date +%Y%m%d-%H%M%S).dump}"

if [[ -z "$NEW_DIRECT_URL" ]]; then
  echo "error: pass the new DIRECT_URL as the first argument." >&2
  echo "  ./scripts/migrate-region.sh 'postgresql://postgres:PASS@db.NEW.supabase.co:5432/postgres'" >&2
  exit 1
fi

if [[ "$NEW_DIRECT_URL" == *":6543"* ]]; then
  echo "error: that looks like the POOLED url (port 6543)." >&2
  echo "       Use the direct/session url on port 5432 — restore fails through pgbouncer." >&2
  exit 1
fi

# ---------------------------------------------------------------- preflight --
if ! command -v pg_dump >/dev/null 2>&1; then
  cat >&2 <<'EOF'
error: pg_dump not found.

The source server is PostgreSQL 17, so you need client tools >= 17:

  brew install libpq
  echo 'export PATH="/opt/homebrew/opt/libpq/bin:$PATH"' >> ~/.zshrc
  exec zsh

(libpq is keg-only, which is why it needs the PATH line.)
EOF
  exit 1
fi

DUMP_MAJOR="$(pg_dump --version | grep -oE '[0-9]+' | head -1)"
if (( DUMP_MAJOR < 17 )); then
  echo "error: pg_dump is version $DUMP_MAJOR but the server is 17. Upgrade: brew install libpq" >&2
  exit 1
fi

# Read the source url out of .env.local rather than asking for it twice.
ENV_FILE="$(dirname "$0")/../.env.local"
OLD_DIRECT_URL="$(grep -E '^DIRECT_URL=' "$ENV_FILE" | head -1 | sed -E 's/^DIRECT_URL=//; s/^"//; s/"$//')"
if [[ -z "$OLD_DIRECT_URL" ]]; then
  echo "error: could not read DIRECT_URL from $ENV_FILE" >&2
  exit 1
fi

echo "source : ${OLD_DIRECT_URL##*@}"
echo "target : ${NEW_DIRECT_URL##*@}"
echo "dump   : $DUMP_FILE"
echo

# Refuse to write into a database that already has tables — this script is for
# a fresh project, and restoring over live data is not something to do by
# accident.
EXISTING="$(psql "$NEW_DIRECT_URL" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
if [[ "$EXISTING" != "0" ]]; then
  echo "error: target already has $EXISTING tables in 'public'. Refusing to restore over it." >&2
  echo "       Use a brand-new Supabase project, or drop the schema yourself first." >&2
  exit 1
fi

# ---------------------------------------------------------------- the move --
echo "==> dumping (about 157 MB, most of it the 495k-row Puzzle table)"
pg_dump --format=custom --no-owner --no-acl --file="$DUMP_FILE" "$OLD_DIRECT_URL"
echo "    wrote $(du -h "$DUMP_FILE" | cut -f1)"

echo "==> restoring"
# --no-owner/--no-acl: Supabase manages its own roles, so ownership from the old
# project must not be carried across.
pg_restore --no-owner --no-acl --dbname="$NEW_DIRECT_URL" "$DUMP_FILE"

# ------------------------------------------------------------ verification --
echo
echo "==> verifying row counts (source vs target)"
COUNT_SQL="SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE schemaname='public' ORDER BY relname"

# ANALYZE first: n_live_tup is an estimate maintained by the stats collector and
# is zero on a freshly restored table until it has been analyzed.
psql "$NEW_DIRECT_URL" -qc "ANALYZE" >/dev/null

diff <(psql "$OLD_DIRECT_URL" -tAF' ' -c "$COUNT_SQL") \
     <(psql "$NEW_DIRECT_URL" -tAF' ' -c "$COUNT_SQL") \
  && echo "    row counts match" \
  || echo "    !! counts differ — review the diff above before cutting over"

echo
echo "==> index check (the ones added for performance)"
psql "$NEW_DIRECT_URL" -tAc \
  "SELECT indexname FROM pg_indexes
   WHERE schemaname='public'
     AND indexname IN ('Game_whiteUserId_playedAt_idx',
                       'Game_blackUserId_playedAt_idx',
                       'game_reports_userId_createdAt_idx')
   ORDER BY indexname"

cat <<EOF

==> done. Nothing has been switched over yet.

Next, by hand:
  1. In .env.local, point DATABASE_URL at the new project's POOLED url (6543)
     and DIRECT_URL at its direct url (5432).
  2. Restart the dev server.
  3. Sanity check: log in, open /dashboard/games, generate a dossier.
  4. Confirm the latency win — the handshake should drop from ~150 ms to ~25 ms:
       node -e "const t=Date.now();require('net').createConnection(5432,'db.NEW.supabase.co').on('connect',function(){console.log(Date.now()-t+' ms');this.end()})"

Keep the Tokyo project running until you are confident. Deleting it is a
separate, deliberate step — not part of this migration.
EOF
