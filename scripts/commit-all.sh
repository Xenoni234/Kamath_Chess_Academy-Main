#!/usr/bin/env bash
#
# Commit the whole working tree as 15 logical commits.
#
#   ./scripts/commit-all.sh --dry-run     # show what each commit would contain
#   ./scripts/commit-all.sh               # actually commit
#
# Nothing is pushed. Review with `git log --stat` afterwards and push yourself.
#
# Why a script instead of just committing: this stages each group by explicit
# path. With 120+ changed paths, `git add -A` per commit would sweep unrelated
# work into whichever commit ran first, and the mistake is invisible until you
# try to revert one of them.
#
# Two guards, both of which abort the whole run:
#   - a live database credential in .env.example (it was there; it must not enter
#     git history)
#   - anything left unstaged after commit 15 (a path nobody assigned to a group)

set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

fail() { echo "ABORT: $*" >&2; exit 1; }

# ---------------------------------------------------------------- guard one --
# The working tree had a real Mumbai connection string on line 2 of .env.example.
# It was never committed; these commits must not be the first time.
if git diff -- .env.example | grep -qE 'pooler\.supabase\.com|@db\.[a-z]+\.supabase\.co'; then
  fail ".env.example still contains a live database host. Restore the placeholder first."
fi
if grep -qE 'pooler\.supabase\.com|@db\.[a-z]+\.supabase\.co' .env.example; then
  fail ".env.example contains a live database host. Restore the placeholder first."
fi
echo "✓ .env.example carries no live credential"

if [[ -n "$(git diff --cached --name-only)" ]]; then
  fail "Something is already staged. Run 'git reset' and start clean."
fi

# ------------------------------------------------------------------ helpers --
commit_n=0
# Dry run resets the index after each group, so coverage is tracked here instead.
DRY_LOG="$(mktemp)"
trap 'rm -f "$DRY_LOG"' EXIT

# stage <path>...   — tolerant of paths that do not exist in this tree
stage() {
  for path in "$@"; do
    if [[ -e "$path" ]] || git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
      git add -A -- "$path"
    fi
  done
}

# do_commit_body <subject> <body>
do_commit_body() {
  local subject="$1" body="$2"
  commit_n=$((commit_n + 1))
  local staged
  staged="$(git diff --cached --name-only | wc -l | tr -d ' ')"
  if [[ "$staged" == "0" ]]; then
    echo "  [$commit_n] SKIP (nothing staged) — $subject"
    return
  fi
  if $DRY_RUN; then
    echo "  [$commit_n] $subject   ($staged paths)"
    git diff --cached --name-only >> "$DRY_LOG"
    git diff --cached --name-only | sed 's/^/         /'
    git reset --quiet
  else
    git commit --quiet -m "$subject" -m "$body"
    echo "  [$commit_n] $subject   ($staged paths)"
  fi
}

# do_commit <message>
do_commit() {
  local message="$1"
  commit_n=$((commit_n + 1))
  local staged
  staged="$(git diff --cached --name-only | wc -l | tr -d ' ')"

  if [[ "$staged" == "0" ]]; then
    echo "  [$commit_n] SKIP (nothing staged) — $message"
    return
  fi

  if $DRY_RUN; then
    echo "  [$commit_n] $message   ($staged paths)"
    git diff --cached --name-only >> "$DRY_LOG"
    git diff --cached --name-only | sed 's/^/         /'
    git reset --quiet
  else
    git commit --quiet -m "$message"
    echo "  [$commit_n] $message   ($staged paths)"
  fi
}

echo
$DRY_RUN && echo "DRY RUN — nothing will be committed." && echo

# ------------------------------------------------------------- the commits --

stage .env.example
do_commit "fix(config): restore .env.example to placeholder credentials"

stage prisma/schema.prisma package.json package-lock.json
do_commit "chore(db): schema for attendance, fees, consent, invoicing and annotations"

stage src/lib/portals.ts "src/app/(auth)/login" src/components/auth/LoginForm.tsx \
      src/proxy.ts src/components/dashboard/DashboardSidebar.tsx \
      "src/app/(dashboard)/dashboard/student/page.tsx" \
      "src/app/(dashboard)/dashboard/parent/page.tsx" \
      "src/app/(dashboard)/dashboard/coach/page.tsx" \
      "src/app/(dashboard)/dashboard/hr/page.tsx" \
      "src/app/(dashboard)/dashboard/head/page.tsx"
do_commit "feat(auth): role-scoped login portals and per-role dashboards"

stage src/lib/otp.ts src/app/api/auth/otp src/app/api/auth/reset-password \
      src/app/api/auth/register/route.ts "src/app/(auth)/forgot-password" \
      "src/app/(auth)/register/page.tsx"
do_commit "fix(auth): working OTP registration and password reset"

stage src/app/api/analysis/explain/route.ts src/app/api/auth/refresh/route.ts \
      src/app/api/batches src/app/api/classes/route.ts \
      src/app/api/games/route.ts "src/app/api/games/[gameId]/route.ts" \
      src/app/api/notifications src/app/api/opening src/app/api/puzzles \
      src/app/api/reports src/app/api/second src/app/api/tournaments \
      src/app/api/user/rating/route.ts src/app/api/users src/app/api/dev \
      src/lib/validations/phase2.ts src/components/analysis/ExplainPanel.tsx \
      "src/app/(dashboard)/opening" "src/app/(dashboard)/second" \
      "src/app/(dashboard)/game"
do_commit "refactor(api): separate auth failure from server fault across route handlers"

stage src/app/api/admin/users src/app/api/admin/parent-links src/app/api/payments/route.ts \
      "src/app/api/payments/[id]/route.ts" "src/app/(dashboard)/dashboard/admin/users" \
      "src/app/(dashboard)/dashboard/admin/payments" src/lib/validations/admin.ts \
      src/lib/authz.ts
do_commit "feat(admin): staff console for accounts, parent links and fees"

stage src/app/api/students \
      "src/app/(dashboard)/dashboard/roster" "src/app/(dashboard)/dashboard/children" \
      "src/app/(dashboard)/dashboard/student-detail" \
      src/components/dashboard/StudentList.tsx src/components/common
do_commit "feat(academy): student overviews, coach roster and parent children views"

stage src/lib/media/roomClient.ts src/lib/socket/handlers/mediaHandlers.ts \
      src/lib/validations/socket.ts server.mjs
do_commit "feat(media): mediasoup SFU signalling for live class rooms"

stage src/lib/pdf src/lib/second/pdf.ts src/lib/opening/pdf.ts \
      src/lib/reports/runReportJob.ts src/lib/queue/worker.ts \
      scripts/verifyPdfLaunch.ts
do_commit "fix(pdf): run Chromium without a sandbox and harden the job queue"

stage "src/app/api/classes/[id]/room/route.ts" \
      "src/app/(dashboard)/dashboard/classes/[id]/room/page.tsx" \
      src/lib/media/enabled.ts src/lib/media/mediasoup.ts scripts/verifyRoomSecurity.ts
do_commit_body "fix(classes): stop exposing class rooms and student names to public Jitsi" \
"The room used to be meet.jit.si/KCA-<class id>, derivable by anyone who saw or
guessed a class id, with the student's display name in the URL fragment. The room
name is now a server-minted secret, handed out only past the authorisation check
and rotated on every class start, and the name goes through the Jitsi IFrame API
rather than the URL.

room/page.tsx also carries the coach attendance panel, which belongs with the
following commit. The two changes are in one file and cannot be separated without
interactive staging."

stage src/app/api/attendance scripts/verifyAttendance.ts
do_commit "feat(classes): class attendance API and the coach marking panel"


stage src/lib/validations/compliance.ts src/app/api/user/consent \
      src/app/api/contact/route.ts src/app/api/admin/contact \
      "src/app/(dashboard)/dashboard/admin/contact" src/lib/compliance \
      scripts/backfillConsent.ts scripts/anonymiseUser.ts \
      scripts/verifyConsent.ts scripts/verifyContact.ts scripts/verifyAnonymise.ts
do_commit "feat(compliance): consent records, staff contact inbox and account anonymisation"

stage src/lib/payments src/lib/razorpay.ts src/lib/queue/queues.ts \
      "src/app/api/payments/[id]/invoice" src/app/api/payments/order \
      src/app/api/payments/webhook "src/app/(dashboard)/dashboard/fees" \
      scripts/verifyInvoice.ts scripts/verifyRazorpay.ts
do_commit "feat(payments): invoice generation and Razorpay orders, webhook and checkout"

stage src/lib/auditActions.ts src/app/api/admin/audit \
      "src/app/(dashboard)/dashboard/admin/audit" \
      "src/app/api/games/[gameId]/annotations" \
      src/components/analysis/AnnotationPanel.tsx \
      src/components/analysis/AnalysisMoveList.tsx \
      "src/app/(dashboard)/analysis/AnalysisBoardClient.tsx" \
      src/components/auth/RoleContext.tsx "src/app/(dashboard)/layout.tsx" \
      "src/app/(dashboard)/dashboard/tournaments" \
      scripts/verifyAudit.ts scripts/verifyAnnotation.ts
do_commit "feat(analysis): coach annotations, audit log viewer and role context"

stage "src/app/(public)/refund" "src/app/(public)/privacy/page.tsx" \
      "src/app/(public)/terms/page.tsx" src/components/public/Footer.tsx \
      src/components/public/LegalDoc.tsx AGENTS.md DEPLOYMENT.md README.md \
      TESTING.md PHASE6_PLAN.md scripts/migrate-region.sh \
      scripts/createHeadUser.ts scripts/verifyRoles.ts scripts/verifyRegistration.ts \
      scripts/commit-all.sh
do_commit "docs(legal): refund policy, processor list, footer links and project docs"

# ---------------------------------------------------------------- guard two --
echo
if $DRY_RUN; then
  # Compare what the groups would have staged against everything that changed.
  git status --porcelain -uall | sed 's/^...//' | sed 's/^"//; s/"$//' | sort -u > "$DRY_LOG.all"
  sort -u "$DRY_LOG" > "$DRY_LOG.covered"
  LEFT="$(comm -23 "$DRY_LOG.all" "$DRY_LOG.covered" || true)"
  rm -f "$DRY_LOG.all" "$DRY_LOG.covered"
else
  LEFT="$(git status --porcelain -uall | grep -v 'node_modules' || true)"
fi

if [[ -n "$LEFT" ]]; then
  echo "⚠️  PATHS NOT ASSIGNED TO ANY COMMIT — add them to a group and re-run:" >&2
  echo "$LEFT" | sed 's/^/    /' >&2
  fail "$(echo "$LEFT" | wc -l | tr -d ' ') path(s) left over."
else
  echo "✓ every changed path is covered by a commit"
fi

echo
if $DRY_RUN; then
  echo "Dry run complete. Re-run without --dry-run to commit."
else
  echo "Done. Review with:  git log --oneline -15"
  echo "Nothing has been pushed."
fi
