#!/usr/bin/env bash
#
# Ship a change to the live server. Run this ON THE VPS, from /opt/kca.
#
#   ssh root@YOUR_SERVER_IP
#   cd /opt/kca && ./scripts/redeploy.sh
#
# Deploying is not a one-way door: you edit locally, push to GitHub, and run this.
# The site is down only for the few seconds the app container restarts — the
# database is in Supabase and is never touched by a redeploy, so no data moves.
#
# What this deliberately does NOT do is apply schema changes. `prisma db push`
# against a live database is a decision, not a step: it can drop a column while
# students are mid-session. Run it by hand, after reading the diff.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Current version"
git log -1 --format='    %h %s (%ar)'

echo
echo "==> Fetching"
git fetch --quiet origin

BEHIND="$(git rev-list --count HEAD..origin/main)"
if [ "$BEHIND" -eq 0 ]; then
  echo "    Already up to date with origin/main."
else
  echo "    $BEHIND new commit(s):"
  git log --format='    %h %s' HEAD..origin/main
fi

# A change made directly on the server (a hand-edited Caddyfile, say) would be
# silently destroyed by the pull. Stop and let a human decide.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo
  echo "STOP: there are uncommitted changes on the server:" >&2
  git status --porcelain >&2
  echo >&2
  echo "Someone edited files here directly. Save them somewhere, then re-run." >&2
  exit 1
fi

echo
echo "==> Pulling"
git pull --ff-only origin main

echo
echo "==> Rebuilding (the site stays up until the new image is ready)"
docker compose up -d --build

echo
echo "==> Waiting for the app to come back"
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null http://localhost:3000/api/health 2>/dev/null; then
    echo "    Healthy after ${i}s."
    echo
    echo "==> Now live:"
    git log -1 --format='    %h %s'
    exit 0
  fi
  sleep 1
done

echo
echo "WARNING: the app did not answer /api/health within 30s." >&2
echo "Check the logs — the previous container may have exited:" >&2
echo "    docker compose logs --tail=50 app" >&2
exit 1
