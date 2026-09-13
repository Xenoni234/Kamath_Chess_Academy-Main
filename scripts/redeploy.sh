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

# Re-exec if the pull changed THIS script.
#
# Bash reads a script incrementally from a file offset, so `git pull` rewriting
# redeploy.sh mid-run means the rest of the file is read from the NEW bytes at an offset
# computed against the OLD ones. In the best case you run the old logic; in the worst you
# run a line spliced out of the middle of a different one.
#
# This bit us for real: the deploy that fixed parallel builds pulled itself in, then went
# on to build in parallel anyway, because bash was already past that point. The fix only
# took effect one deploy later — which is the sort of thing that looks like the fix not
# working.
#
# `KCA_REDEPLOY_REEXEC` guards against looping if the script somehow keeps changing.
if [ -z "${KCA_REDEPLOY_REEXEC:-}" ] && ! git diff --quiet HEAD@{1} HEAD -- "$0" 2>/dev/null; then
  echo "    This script changed in that pull — restarting it so the new version runs."
  KCA_REDEPLOY_REEXEC=1 exec "$0" "$@"
fi

echo
# Build ONE image at a time. This box has 2 vCPUs and a few GB of RAM, and
# `docker compose up --build` builds `app` and `worker` in PARALLEL — two Next.js
# builds at once, beside the live stack that is still serving traffic. That is what
# wedged the server: it swapped until SSH and HTTP both stopped answering, and the
# site was down until it was rebooted from the hosting panel.
#
# Serial builds take longer and finish.
echo "==> Rebuilding (the site stays up until the new image is ready)"
echo "    Building one image at a time — parallel builds have OOMed this box before."
# Two separate invocations, each naming ONE service — serial by construction, with no
# flag whose support varies between compose versions.
docker compose build app
docker compose build worker

echo "==> Swapping containers"
docker compose up -d --no-build

echo
echo "==> Waiting for the app to come back"
# Check from INSIDE the compose network, not from the host. docker-compose.yml
# uses `expose`, not `ports`, so 3000 is reachable only between containers —
# Caddy is the sole public door. Curling localhost:3000 on the host could never
# succeed, so this check reported a failed deploy on a deploy that had worked.
for i in $(seq 1 30); do
  if docker compose exec -T app node -e \
      "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
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
