/**
 * Remove seeded demo data and zero out money, WITHOUT touching real accounts.
 *
 *   npx tsx --env-file=.env.local scripts/cleanDemoData.ts            # dry run, shows what it would do
 *   npx tsx --env-file=.env.local scripts/cleanDemoData.ts --yes      # actually do it
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

async function main() {
  console.log(LIVE ? "MODE: LIVE — changes will be written\n" : "MODE: DRY RUN — nothing will change\n");

  // ---- 1. Demo accounts -----------------------------------------------------
  const demoUsers = await db.user.findMany({
    where: { username: { startsWith: DEMO_PREFIX } },
    select: { id: true, username: true, role: true, email: true },
  });

  console.log(`Demo accounts (username starts with "${DEMO_PREFIX}"): ${demoUsers.length}`);
  for (const u of demoUsers) console.log(`   - ${u.username} (${u.role})`);

  // ---- 2. Seeded batches and their classes ----------------------------------
  const demoBatches = await db.batch.findMany({
    where: { description: SEEDED_BATCH_NOTE },
    select: { id: true, name: true, _count: { select: { classes: true } } },
  });
  console.log(`\nSeeded batches: ${demoBatches.length}`);
  for (const b of demoBatches) console.log(`   - ${b.name} (${b._count.classes} classes)`);

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

  // Seeded batches. Classes cascade from the batch relation where the schema says so;
  // deleting them explicitly first keeps this correct either way.
  for (const batch of demoBatches) {
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
