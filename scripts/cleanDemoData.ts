/**
 * Remove seeded demo data and zero out money, WITHOUT touching real accounts.
 *
 *   npx tsx --env-file=.env.local scripts/cleanDemoData.ts                       # dry run
 *   npx tsx --env-file=.env.local scripts/cleanDemoData.ts --yes                 # apply
 *   npx tsx --env-file=.env.local scripts/cleanDemoData.ts --users=a,b --batches=test
 *
 * `--users` and `--batches` name extra things to remove beyond the seeded `demo*` set —
 * for accounts and batches created by hand during testing, which no prefix identifies.
 * They are matched EXACTLY and case-sensitively: a prefix match on hand-typed names is
 * how you delete a real student called "testa" while aiming at "test".
 *
 * `resetTestData.ts` deletes every row in every table. That was the right tool while the
 * platform had no users; it is the wrong one now that real students have accounts. This is
 * the surgical version: it names exactly what it will remove, shows you first, and only
 * acts on the second run.
 *
 * What it removes:
 *   - users whose username starts with `demo` (what seedDemoAccounts.ts creates), and
 *     everything hanging off them;
 *   - batches the seed script created, and their classes;
 *   - ALL payments and invoices — "any money added to any account, make it nil";
 *   - any class still marked ONGOING, closed off as COMPLETED, because a class nobody
 *     pressed End on sits in the students' "Live now" list forever.
 *
 * Deleting a user is not one statement. `GameReport.user` is `Restrict` on purpose (see
 * AGENTS.md — it is a data-loss guard for a future real delete), so the reports must go
 * first or the delete throws. Relations that are `SetNull` leave orphan rows pointing at
 * nobody, which is correct for game history and deliberate.
 */
import { db } from "../src/lib/db";

const DEMO_PREFIX = "demo";
const SEEDED_BATCH_NOTE = "Seeded by scripts/seedDemoAccounts.ts";
const LIVE = !process.argv.includes("--dry-run") && process.argv.includes("--yes");

/** `--users=a,b` / `--batches=x,y` — exact names, never prefixes. */
function listArg(name: string): string[] {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!raw) return [];
  return raw.slice(name.length + 3).split(",").map((v) => v.trim()).filter(Boolean);
}
const EXTRA_USERS = listArg("users");
const EXTRA_BATCHES = listArg("batches");

/** Wipe every batch and class, not just named ones — pre-launch scheduling test data. */
const ALL_SCHEDULING = process.argv.includes("--all-classes");

/**
 * Also delete games the removed accounts played.
 *
 * `Game.whiteUserId` is `SetNull`, so deleting a player leaves the game behind with an
 * empty seat. That is correct for real history — a game two people played happened, even
 * after one deletes their account — but for test games it leaves ghosts in everyone's
 * Games list with a blank opponent.
 */
const DROP_GAMES = process.argv.includes("--games");

/**
 * Clear the audit entries belonging to the accounts being removed — and ONLY those.
 *
 * Not the whole log. `AuditLog` is the record DPDPA expects of who looked at whose
 * personal data, and the entries for accounts that are staying are still that record.
 * Wiping the table to tidy up three test accounts would throw away the trail for six real
 * ones.
 *
 * Note `AuditLog.userId` is `SetNull`, so deleting a user leaves their rows behind with a
 * null actor rather than removing them. That is deliberate in the schema — an erasure has
 * to stay provable — which is exactly why removing them needs its own explicit flag.
 */
const CLEAR_AUDIT = process.argv.includes("--audit");

async function main() {
  console.log(LIVE ? "MODE: LIVE — changes will be written\n" : "MODE: DRY RUN — nothing will change\n");

  // ---- 1. Demo accounts -----------------------------------------------------
  const demoUsers = await db.user.findMany({
    where: {
      OR: [
        { username: { startsWith: DEMO_PREFIX } },
        ...(EXTRA_USERS.length ? [{ username: { in: EXTRA_USERS } }] : []),
      ],
    },
    select: { id: true, username: true, role: true, email: true },
  });

  // A named account that does not exist is almost always a typo, and silently deleting
  // nothing is worse than saying so.
  for (const wanted of EXTRA_USERS) {
    if (!demoUsers.some((u) => u.username === wanted)) {
      console.log(`   ! no account named "${wanted}" — check the spelling`);
    }
  }

  const heads = demoUsers.filter((u) => u.role === "HEAD");
  if (heads.length) {
    console.error(
      `\nREFUSING: this would delete the HEAD account(s) ${heads.map((h) => h.username).join(", ")}.\n` +
        "The academy owner's account is not test data. Remove it from --users and re-run.",
    );
    process.exit(1);
  }

  console.log(`Demo accounts (username starts with "${DEMO_PREFIX}"): ${demoUsers.length}`);
  for (const u of demoUsers) console.log(`   - ${u.username} (${u.role})`);

  // ---- 2. Seeded batches and their classes ----------------------------------
  const demoBatches = await db.batch.findMany({
    where: {
      OR: [
        { description: SEEDED_BATCH_NOTE },
        ...(EXTRA_BATCHES.length ? [{ name: { in: EXTRA_BATCHES } }] : []),
      ],
    },
    select: { id: true, name: true, _count: { select: { classes: true } } },
  });
  const allBatches = ALL_SCHEDULING
    ? await db.batch.findMany({ select: { id: true, name: true, _count: { select: { classes: true } } } })
    : demoBatches;
  const targetBatches = ALL_SCHEDULING ? allBatches : demoBatches;

  console.log(`\n${ALL_SCHEDULING ? "ALL batches" : "Seeded batches"}: ${targetBatches.length}`);
  for (const b of targetBatches) console.log(`   - ${b.name} (${b._count.classes} classes)`);

  const classCount = ALL_SCHEDULING ? await db.class.count() : 0;
  if (ALL_SCHEDULING) {
    const classes = await db.class.findMany({ select: { title: true, status: true } });
    console.log(`\nALL classes: ${classCount}`);
    for (const c of classes) console.log(`   - ${c.title} [${c.status}]`);
  }

  const gamesToDrop = DROP_GAMES && demoUsers.length
    ? await db.game.count({
        where: {
          OR: [
            { whiteUserId: { in: demoUsers.map((u) => u.id) } },
            { blackUserId: { in: demoUsers.map((u) => u.id) } },
          ],
        },
      })
    : 0;
  if (DROP_GAMES) console.log(`\nGames played by those accounts: ${gamesToDrop}`);

  const auditCount =
    CLEAR_AUDIT && demoUsers.length
      ? await db.auditLog.count({ where: { userId: { in: demoUsers.map((u) => u.id) } } })
      : 0;
  if (CLEAR_AUDIT) {
    const total = await db.auditLog.count();
    console.log(`\nAudit log entries for those accounts: ${auditCount} (of ${total} total — the rest stay)`);
  }

  // ---- 3. Money -------------------------------------------------------------
  const [paymentCount, invoiceCount] = await Promise.all([
    db.payment.count(),
    db.invoice.count(),
  ]);
  console.log(`\nPayments to delete: ${paymentCount}`);
  console.log(`Invoices to delete: ${invoiceCount}`);

  // ---- 4. Classes left hanging in ONGOING -----------------------------------
  const stuckLive = await db.class.findMany({
    where: { status: "ONGOING" },
    select: { id: true, title: true, endsAt: true },
  });
  console.log(`\nClasses stuck on "live" (never ended): ${stuckLive.length}`);
  for (const c of stuckLive) console.log(`   - ${c.title} (was due to end ${c.endsAt.toISOString()})`);

  if (!LIVE) {
    console.log("\nNothing was changed. Re-run with --yes to apply.");
    return;
  }

  console.log("\nApplying…");

  // Close off stale live classes first — cheap, and it is the thing students see.
  if (stuckLive.length) {
    const { count } = await db.class.updateMany({
      where: { status: "ONGOING" },
      data: { status: "COMPLETED" },
    });
    console.log(`   ${count} class(es) marked COMPLETED`);
  }

  // Money. Invoices reference payments, so they go first.
  if (invoiceCount) {
    const { count } = await db.invoice.deleteMany({});
    console.log(`   ${count} invoice(s) deleted`);
  }
  if (paymentCount) {
    const { count } = await db.payment.deleteMany({});
    console.log(`   ${count} payment(s) deleted`);
  }
  // The invoice sequence is reset too, so the first real invoice is number 1 rather than
  // continuing from the test data. Gaps are correct in a live sequence; starting a brand
  // new one mid-air is not.
  await db.invoiceCounter.deleteMany({});
  console.log("   invoice counter reset");

  if (DROP_GAMES && demoUsers.length) {
    const ids = demoUsers.map((u) => u.id);
    const { count } = await db.game.deleteMany({
      where: { OR: [{ whiteUserId: { in: ids } }, { blackUserId: { in: ids } }] },
    });
    console.log(`   ${count} game(s) deleted`);
  }

  if (ALL_SCHEDULING) {
    const cls = await db.class.deleteMany({});
    console.log(`   ${cls.count} class(es) deleted`);
  }

  if (CLEAR_AUDIT && demoUsers.length) {
    const { count } = await db.auditLog.deleteMany({
      where: { userId: { in: demoUsers.map((u) => u.id) } },
    });
    console.log(`   ${count} audit log entr(ies) cleared for the removed accounts`);
  }

  // Batches. Classes cascade from the batch relation where the schema says so;
  // deleting them explicitly first keeps this correct either way.
  for (const batch of targetBatches) {
    await db.class.deleteMany({ where: { batchId: batch.id } });
    await db.batch.delete({ where: { id: batch.id } });
    console.log(`   batch "${batch.name}" and its classes deleted`);
  }

  // Demo users last, reports first — GameReport is Restrict, so the delete throws
  // otherwise, and it throws AFTER the other deletions have already happened.
  for (const user of demoUsers) {
    await db.gameReport.deleteMany({ where: { userId: user.id } });
    await db.otpVerification.deleteMany({ where: { email: user.email.toLowerCase() } });
    await db.user.delete({ where: { id: user.id } });
    console.log(`   user "${user.username}" deleted`);
  }

  console.log("\nDone.");
}

main()
  .catch((error) => {
    console.error("\ncleanDemoData failed:", error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
