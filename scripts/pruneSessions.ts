/**
 * Delete expired login sessions. Nothing else ever does.
 *
 *   npx tsx --env-file=.env.local scripts/pruneSessions.ts                      # dry run
 *   npx tsx --env-file=.env.local scripts/pruneSessions.ts --yes                # prune expired
 *   npx tsx --env-file=.env.local scripts/pruneSessions.ts --user=someone --yes # revoke ALL
 *                                                                              # of one account's
 *
 * `UserSession` rows are created on every single login and removed only on logout, password
 * reset, account deactivation or erasure. A refresh token lives **7 days**, so every user who
 * closes the tab instead of signing out leaves a row behind for good. The table has
 * `@@index([expiresAt])` already — a cleanup was clearly intended when the schema was written
 * and then never got built.
 *
 * It became visible on 10 Oct 2026: the login flood created a session per successful attempt,
 * and all of them were still sitting there afterwards. Rows that cannot authenticate anything
 * are not harmless — they are credential material (a refresh token per row) kept past its
 * purpose, which under the DPDPA is exactly what retention limits are about.
 *
 * Deliberately a cron job rather than an opportunistic delete during login: adding a write to
 * that route is the opposite of the point, since its cost under load is what took the platform
 * down. Run it daily — see DEPLOYMENT.md.
 *
 * An EXPIRED row is the only thing this touches. A live session is never pruned, however old,
 * because `expiresAt` is the only thing that decides whether a token still works; guessing from
 * `createdAt` would sign people out mid-lesson.
 */
import { db } from "../src/lib/db";

const APPLY = process.argv.includes("--yes");

/**
 * `--user=<username>` revokes EVERY session for one account, expired or not, signing it out on
 * every device. Needed because pruning expired rows is the wrong tool after a credential
 * incident: the 10 Oct 2026 flood used valid credentials, so it left ~1,700 sessions that are
 * perfectly LIVE and each carry a usable 7-day refresh token. A rate limit stops new ones being
 * minted; it cannot reach into the ones already handed out.
 *
 * Changing the password does NOT revoke them on its own — `/api/auth/refresh` looks the token up
 * in this table and never consults the password — so this is the step that actually ends access.
 * (`/api/auth/reset-password` does clear sessions, but only for the account doing the reset.)
 */
const USER_FLAG = process.argv.find((arg) => arg.startsWith("--user="));
const TARGET_USERNAME = USER_FLAG ? USER_FLAG.slice("--user=".length) : null;

/** Revoke every session belonging to one account. Matched EXACTLY — see cleanDemoData.ts on why. */
async function revokeForUser(username: string) {
  const user = await db.user.findUnique({
    where: { username },
    select: { id: true, username: true, role: true },
  });

  if (!user) {
    // Exact, case-sensitive: a prefix or fuzzy match here signs out the wrong child.
    console.error(`No account with username exactly "${username}". Nothing done.`);
    process.exitCode = 1;
    return;
  }

  const count = await db.userSession.count({ where: { userId: user.id } });
  console.log(`${user.username} (${user.role}) has ${count} session(s).`);

  if (count === 0) return;

  if (!APPLY) {
    console.log(
      `\nDry run — nothing deleted. Re-run with --yes to sign ${user.username} out everywhere.`,
    );
    return;
  }

  const removed = await db.userSession.deleteMany({ where: { userId: user.id } });
  console.log(`\nRevoked ${removed.count} session(s). ${user.username} is signed out everywhere.`);
  console.log(
    "Also change that account's password if the credentials themselves are known to anyone —\n" +
      "revoking sessions ends existing access, it does not stop a fresh login.",
  );
}

async function main() {
  const now = new Date();

  if (TARGET_USERNAME) {
    await revokeForUser(TARGET_USERNAME);
    return;
  }

  const [total, expired] = await Promise.all([
    db.userSession.count(),
    db.userSession.count({ where: { expiresAt: { lt: now } } }),
  ]);

  console.log(`Sessions: ${total} total, ${expired} expired, ${total - expired} live.`);

  if (expired === 0) {
    console.log("Nothing to prune.");
    return;
  }

  // Show the shape of what would go, so an unexpected number is questioned rather than applied.
  const oldest = await db.userSession.findFirst({
    where: { expiresAt: { lt: now } },
    orderBy: { expiresAt: "asc" },
    select: { expiresAt: true, createdAt: true },
  });

  if (oldest) {
    const days = Math.floor((now.getTime() - oldest.expiresAt.getTime()) / 86_400_000);
    console.log(
      `Oldest expired session lapsed ${days} day(s) ago ` +
        `(created ${oldest.createdAt.toISOString().slice(0, 10)}).`,
    );
  }

  // Who holds all this? After an incident this is the question that matters, and a bare total
  // cannot answer it. A single account with hundreds of LIVE sessions is not a person using the
  // site — it is a script that logged in successfully, over and over, and every one of those
  // rows is a refresh token that still works.
  const byUser = await db.userSession.groupBy({
    by: ["userId"],
    _count: { _all: true },
    orderBy: { _count: { userId: "desc" } },
    take: 5,
  });

  if (byUser.length > 0) {
    console.log("\nMost sessions by account:");
    for (const row of byUser) {
      const user = await db.user.findUnique({
        where: { id: row.userId },
        select: { username: true, role: true },
      });
      const live = await db.userSession.count({
        where: { userId: row.userId, expiresAt: { gte: now } },
      });
      console.log(
        `   ${user?.username ?? row.userId} (${user?.role ?? "?"}): ` +
          `${row._count._all} total, ${live} live`,
      );
    }
    console.log(
      "\n   A live count in the hundreds is an attack artefact, not a user. This script will\n" +
        "   NOT remove those — they have not expired. Clear one account's sessions deliberately\n" +
        "   (it signs that account out everywhere) rather than pruning live rows wholesale.",
    );
  }

  if (!APPLY) {
    console.log(`\nDry run — nothing deleted. Re-run with --yes to remove ${expired} row(s).`);
    return;
  }

  const { count } = await db.userSession.deleteMany({ where: { expiresAt: { lt: now } } });
  console.log(`\nDeleted ${count} expired session(s).`);

  const remainingLive = await db.userSession.count();
  console.log(`${remainingLive} live session(s) remain — nobody has been signed out.`);
}

main()
  .catch((error) => {
    console.error("\npruneSessions failed:", error);
    process.exitCode = 1;
  })
  // `src/lib/db.ts` holds the pool open for 5 minutes of idle on purpose, so without this the
  // script sits there long after the work is done. Same ending as cleanDemoData.ts.
  .finally(() => process.exit());
