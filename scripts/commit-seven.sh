#!/usr/bin/env bash
#
# The manual-testing fixes, as seven commits.
#
#   ./scripts/commit-seven.sh
#
# Ordering is by dependency, not by importance: `api/auth/register/route.ts`
# imports both `lib/inviteCodes` and `lib/parentCode`, so those land first or the
# auth commit does not build on its own. Same reason `lib/authz.ts` (commit 6)
# precedes the class routes that import `canManageClass` from it (commit 7).
#
# Every `git add` names its paths explicitly — never `git add -A`. With ~70 paths
# the likely failure is silently orphaning one, so the script refuses to finish
# with anything left unstaged.
#
# No `git push`. Review with `git log --stat -7` and push yourself.
set -euo pipefail
cd "$(dirname "$0")/.."

# ---------------------------------------------------------------------------
# Guard: a live database credential once sat in .env.example. Never again.
# ---------------------------------------------------------------------------
# The committed placeholders read postgresql://USER:PASSWORD@HOST:PORT/DATABASE —
# all caps, no digits. A real password has lowercase letters or digits in it, and
# a real Supabase host names the project. Either one aborts.
#
# The check is deliberately about the SHAPE of the value, not a fixed string: the
# credential that was here before was spotted by eye, and eyes are exactly what
# this is replacing.
if grep -qE 'pooler\.supabase\.com|[a-z]{20}\.supabase\.co' .env.example \
   || grep -qE 'postgres(ql)?://[^:"]+:[^@"]*[a-z0-9][^@"]*@' .env.example; then
  echo "ABORT: .env.example looks like it still holds a real credential." >&2
  grep -nE 'supabase\.(com|co)|postgres(ql)?://' .env.example | sed 's/\(:\/\/[^:]*:\)[^@]*@/\1***@/' >&2
  echo "       Replace it with placeholders before committing." >&2
  exit 1
fi
if git ls-files --error-unmatch .env.local >/dev/null 2>&1; then
  echo "ABORT: .env.local is tracked by git. Remove it from the index first." >&2
  exit 1
fi

commit () {
  local msg="$1"; shift
  git add -- "$@"
  if git diff --cached --quiet; then
    echo "  (nothing staged — skipping: $msg)"
    return
  fi
  git commit -q -m "$msg"
  echo "  ✓ $msg"
}

echo "1/7"
commit "chore(db): invite codes, parent codes and requested-role columns" \
  prisma/schema.prisma \
  .env.example \
  scripts/seedDemoAccounts.ts \
  scripts/setHeadPassword.ts \
  scripts/commit-all.sh \
  scripts/commit-seven.sh

echo "2/7"
commit "feat(admin): single-use invite codes for coach and staff signup" \
  src/lib/inviteCodes.ts \
  src/app/api/admin/invite-codes \
  "src/app/(dashboard)/dashboard/admin/invite-codes" \
  scripts/verifyInviteCodes.ts

echo "3/7"
commit "feat(parents): a parent signs up with their child's code, not just a name" \
  src/lib/parentCode.ts \
  src/app/api/user/parent-code \
  src/components/dashboard/ParentCodeCard.tsx \
  "src/app/(dashboard)/dashboard/student/page.tsx" \
  scripts/verifyParentCode.ts

echo "4/7"
commit "feat(auth): pick a role at registration and keep /login to signing in" \
  "src/app/(auth)/login/page.tsx" \
  "src/app/(auth)/login/[portal]/page.tsx" \
  "src/app/(auth)/register/page.tsx" \
  src/components/auth/AuthShell.tsx \
  src/components/auth/LoginForm.tsx \
  src/app/api/auth/register/route.ts \
  src/lib/validations.ts \
  scripts/verifySignupRole.ts \
  scripts/verifyRegistration.ts \
  scripts/verifyConsent.ts

echo "5/7"
commit "fix(email): stop discarding Resend failures, and send from one place" \
  src/lib/email.ts \
  src/lib/otp.ts \
  src/app/api/auth/otp/send/route.ts \
  src/app/api/contact/route.ts \
  src/lib/reports/runReportJob.ts \
  src/lib/payments/runInvoiceJob.ts \
  scripts/verifyEmailFailure.ts \
  scripts/verifyContact.ts

echo "6/7"
commit "fix(money): fees are the head's alone, and stuck jobs now fail" \
  src/lib/authz.ts \
  src/app/api/payments/route.ts \
  "src/app/api/payments/[id]/route.ts" \
  "src/app/api/payments/[id]/invoice/route.ts" \
  src/app/api/payments/order/route.ts \
  "src/app/api/students/[id]/overview/route.ts" \
  "src/app/(dashboard)/dashboard/admin/payments/page.tsx" \
  "src/app/(dashboard)/dashboard/student-detail/[id]/page.tsx" \
  src/lib/queue/reapStaleJobs.ts \
  src/instrumentation.ts \
  server.mjs \
  scripts/verifyMoneyAccess.ts \
  scripts/verifyHeadSecurity.ts \
  scripts/verifyReaper.ts

echo "7/7"
commit "feat(classes): live/upcoming/ended, coach-run sessions and head override" \
  src/app/api/classes/route.ts \
  "src/app/api/classes/[id]/route.ts" \
  "src/app/api/classes/[id]/enroll" \
  "src/app/api/classes/[id]/room/route.ts" \
  src/app/api/batches/route.ts \
  "src/app/api/batches/[id]/route.ts" \
  "src/app/api/batches/[id]/enroll/route.ts" \
  src/app/api/attendance/route.ts \
  src/app/api/admin/coach-activity \
  "src/app/(dashboard)/dashboard/classes/page.tsx" \
  "src/app/(dashboard)/dashboard/classes/[id]/room/page.tsx" \
  "src/app/(dashboard)/dashboard/schedule/page.tsx" \
  "src/app/(dashboard)/dashboard/schedule/ScheduleClient.tsx" \
  src/components/dashboard/DashboardSidebar.tsx \
  src/lib/socket/handlers/classHandlers.ts \
  src/lib/socket/handlers/mediaHandlers.ts \
  src/lib/socket/server.ts \
  src/lib/validations/phase3.ts \
  src/lib/auditActions.ts \
  src/proxy.ts \
  scripts/verifyClassSections.ts \
  scripts/verifyClassManage.ts \
  scripts/verifyCoachAuthority.ts \
  scripts/verifyRoles.ts

# ---------------------------------------------------------------------------
# Nothing may be left behind.
# ---------------------------------------------------------------------------
leftover="$(git status --porcelain)"
if [ -n "$leftover" ]; then
  echo
  echo "STOP: these paths were not committed —" >&2
  echo "$leftover" >&2
  echo >&2
  echo "Add them to a group in this script and re-run, or commit them yourself." >&2
  exit 1
fi

echo
echo "All seven committed. Review before pushing:"
echo "    git log --stat -7"
