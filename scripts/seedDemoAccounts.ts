/**
 * Create demo accounts so every dashboard can be clicked through.
 *
 *   npx tsx --env-file=.env.local scripts/seedDemoAccounts.ts
 *   npx tsx --env-file=.env.local scripts/seedDemoAccounts.ts --remove
 *
 * These are for looking at the product, not for production. Every account shares
 * one obvious password and every username starts with `demo`, so they are easy to
 * spot and easy to delete — which `--remove` does.
 *
 * It also wires up the relationships, because an empty dashboard tells you
 * nothing. Without a batch, an enrolment and a class, the coach's roster is blank
 * and the parent's child view has nothing in it, and you cannot tell a working
 * page from a broken one.
 *
 * Deliberately bypasses registration: it sets roles directly rather than going
 * through invite codes and parent codes. Those paths have their own tests
 * (verifyInviteCodes, verifyParentCode); this is a fixture, not a test of them.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "../src/lib/auth";
import { getOrCreateParentCode } from "../src/lib/parentCode";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const PASSWORD = "demo12345";
const PREFIX = "demo";

const ACCOUNTS = [
  { username: "democoach", email: "democoach@example.com", role: "COACH" as const, mobile: "9000000001" },
  { username: "demostaff", email: "demostaff@example.com", role: "HR" as const, mobile: "9000000002" },
  { username: "demostudent", email: "demostudent@example.com", role: "STUDENT" as const, mobile: "9000000003" },
  { username: "demoparent", email: "demoparent@example.com", role: "PARENT" as const, mobile: "9000000004" },
];

async function remove() {
  const users = await db.user.findMany({
    where: { username: { startsWith: PREFIX } },
    select: { id: true, username: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) {
    console.log("No demo accounts found.");
    return;
  }
  const classes = await db.class.findMany({ where: { title: { startsWith: "Demo" } }, select: { id: true } });
  await db.classAttendance.deleteMany({ where: { classId: { in: classes.map((c) => c.id) } } });
  await db.classEnrollment.deleteMany({ where: { userId: { in: ids } } });
  await db.class.deleteMany({ where: { title: { startsWith: "Demo" } } });
  await db.batch.deleteMany({ where: { name: { startsWith: "Demo" } } });
  await db.parentStudent.deleteMany({ where: { OR: [{ parentId: { in: ids } }, { studentId: { in: ids } }] } });
  const payments = await db.payment.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  await db.invoice.deleteMany({ where: { paymentId: { in: payments.map((p) => p.id) } } });
  await db.payment.deleteMany({ where: { userId: { in: ids } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.coachProfile.deleteMany({ where: { userId: { in: ids } } });
  await db.studentProfile.deleteMany({ where: { userId: { in: ids } } });
  await db.userSession.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  console.log(`Removed ${users.length} demo account(s) and their fixtures.`);
}

async function main() {
  if (process.argv.includes("--remove")) {
    await remove();
    return;
  }

  // Start clean so re-running is safe and idempotent.
  await remove();

  const passwordHash = await hashPassword(PASSWORD);
  const made: Record<string, string> = {};

  for (const account of ACCOUNTS) {
    const user = await db.user.create({
      data: {
        username: account.username,
        email: account.email,
        mobile: account.mobile,
        passwordHash,
        role: account.role,
        isActive: true,
        isVerified: true,
        // Demo accounts consent explicitly, so they look like real rows rather
        // than the "unknown" state a pre-consent account reports.
        consentVersion: "2026-09",
        consentTermsAt: new Date(),
        consentAgeAt: new Date(),
        consentDataProcessingAt: new Date(),
        ...(account.role === "STUDENT" ? { studentProfile: { create: {} } } : {}),
        ...(account.role === "COACH" ? { coachProfile: { create: {} } } : {}),
      },
      select: { id: true, username: true, role: true },
    });
    made[account.role] = user.id;
  }

  // --- the relationships, so the dashboards are not empty ---
  const coachProfile = await db.coachProfile.findUnique({
    where: { userId: made.COACH },
    select: { id: true },
  });

  const batch = await db.batch.create({
    data: {
      name: "Demo Batch — Intermediate",
      coachId: coachProfile!.id,
      description: "Seeded by scripts/seedDemoAccounts.ts",
    },
    select: { id: true },
  });

  await db.classEnrollment.create({ data: { batchId: batch.id, userId: made.STUDENT } });

  const now = Date.now();
  await db.class.create({
    data: {
      title: "Demo Class — Endgames",
      description: "Rook and pawn endings",
      batchId: batch.id,
      coachId: coachProfile!.id,
      startsAt: new Date(now + 24 * 60 * 60 * 1000),
      endsAt: new Date(now + 25 * 60 * 60 * 1000),
    },
  });
  const past = await db.class.create({
    data: {
      title: "Demo Class — Openings",
      batchId: batch.id,
      coachId: coachProfile!.id,
      status: "COMPLETED",
      startsAt: new Date(now - 48 * 60 * 60 * 1000),
      endsAt: new Date(now - 47 * 60 * 60 * 1000),
    },
    select: { id: true },
  });

  // A marked attendance record, so the parent and coach views have history.
  await db.classAttendance.create({
    data: { classId: past.id, userId: made.STUDENT, status: "PRESENT", markedById: made.COACH },
  });

  // A paid and an outstanding fee, so the fee pages show both states.
  await db.payment.create({
    data: {
      userId: made.STUDENT,
      amount: 2000,
      status: "COMPLETED",
      method: "UPI",
      description: "September tuition",
      paidAt: new Date(now - 5 * 24 * 60 * 60 * 1000),
      recordedById: made.HR,
    },
  });
  await db.payment.create({
    data: {
      userId: made.STUDENT,
      amount: 2000,
      status: "PENDING",
      description: "October tuition",
      dueDate: new Date(now + 10 * 24 * 60 * 60 * 1000),
      recordedById: made.HR,
    },
  });

  await db.parentStudent.create({ data: { parentId: made.PARENT, studentId: made.STUDENT } });

  const parentCode = await getOrCreateParentCode(made.STUDENT);

  console.log("\nDemo accounts created. Password for all of them:\n");
  console.log(`    ${PASSWORD}\n`);
  for (const account of ACCOUNTS) {
    console.log(`    ${account.role.padEnd(8)} username: ${account.username.padEnd(14)} email: ${account.email}`);
  }
  console.log("\nWired up:");
  console.log("    democoach  coaches 'Demo Batch — Intermediate'");
  console.log("    demostudent is enrolled in it, with one past class marked PRESENT");
  console.log("    demoparent  is linked to demostudent");
  console.log("    demostudent has one paid and one outstanding fee");
  console.log(`\n    demostudent's parent code: ${parentCode}`);
  console.log("    (use it with username 'demostudent' to register a NEW parent through the real flow)");
  console.log("\nRemove all of this with:  npx tsx --env-file=.env.local scripts/seedDemoAccounts.ts --remove");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
