/**
 * Attendance marking, end to end.
 *
 *   npm run dev            # in another terminal
 *   npx tsx --env-file=.env.local scripts/verifyAttendance.ts
 *
 * The load-bearing assertion is the first one: a class with three enrolled
 * students, none of whom has ever connected, must return all three. The socket
 * `class:roster` event that feeds the "In room" card is connected-only presence,
 * so if the UI ever sourced its roster from there, absent students would be
 * invisible — in the exact case attendance exists to record. This test fails if
 * anyone rewires it that way.
 *
 * Also covers: enrollment via the batch as well as directly (the schema allows
 * either and every access check in the codebase has to handle both), upsert on
 * re-marking, and that a non-coach gets 404 rather than 403.
 *
 * Self-cleaning on every exit path.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { signAccessToken } from "../src/lib/auth";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const TAG = "kcaatttest";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

async function cleanup() {
  const users = await db.user.findMany({ where: { username: { startsWith: TAG } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const classes = await db.class.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
  await db.classAttendance.deleteMany({ where: { classId: { in: classes.map((c) => c.id) } } });
  await db.classEnrollment.deleteMany({ where: { userId: { in: ids } } });
  await db.class.deleteMany({ where: { title: { startsWith: TAG } } });
  await db.batch.deleteMany({ where: { name: { startsWith: TAG } } });
  if (ids.length) {
    await db.coachProfile.deleteMany({ where: { userId: { in: ids } } });
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}

function tokenFor(u: { id: string; username: string; role: string }) {
  return signAccessToken({ userId: u.id, username: u.username, role: u.role as never });
}

async function getRoster(classId: string, token: string) {
  const res = await fetch(`${BASE}/api/attendance?classId=${encodeURIComponent(classId)}`, {
    headers: { Cookie: `kca_access_token=${token}` },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function mark(classId: string, token: string, entries: unknown[]) {
  const res = await fetch(`${BASE}/api/attendance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `kca_access_token=${token}` },
    body: JSON.stringify({ classId, entries }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  await cleanup();

  let mobile = Number(`9${Date.now().toString().slice(-9)}`);
  const mk = async (suffix: string, role: "COACH" | "STUDENT") =>
    db.user.create({
      data: {
        username: `${TAG}${suffix}`,
        email: `${TAG}${suffix}@example.com`,
        mobile: String(mobile++),
        passwordHash: "x",
        role,
      },
      select: { id: true, username: true, role: true },
    });

  const coach = await mk("coach", "COACH");
  const otherCoach = await mk("othercoach", "COACH");
  const s1 = await mk("s1", "STUDENT");
  const s2 = await mk("s2", "STUDENT");
  const s3 = await mk("s3", "STUDENT");

  const coachProfile = await db.coachProfile.create({ data: { userId: coach.id }, select: { id: true } });
  const batch = await db.batch.create({ data: { name: `${TAG} batch`, coachId: coachProfile.id }, select: { id: true } });
  const cls = await db.class.create({
    data: {
      title: `${TAG} class`,
      coachId: coachProfile.id,
      batchId: batch.id,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 3600_000),
    },
    select: { id: true },
  });

  // Two enrolled directly, one through the batch — both paths must appear.
  await db.classEnrollment.create({ data: { classId: cls.id, userId: s1.id } });
  await db.classEnrollment.create({ data: { classId: cls.id, userId: s2.id } });
  await db.classEnrollment.create({ data: { batchId: batch.id, userId: s3.id } });

  const coachToken = tokenFor(coach);

  console.log("1. The roster is enrollment-derived, not presence-derived");
  const initial = await getRoster(cls.id, coachToken);
  check("coach can read the roster", initial.status === 200, `got ${initial.status}`);
  const students: Array<{ id: string; status: string | null }> = initial.body?.students ?? [];
  check("all THREE enrolled students appear though none ever connected",
    students.length === 3, `got ${students.length}`);
  check("the batch-enrolled student is included",
    students.some((s) => s.id === s3.id), students.map((s) => s.id).join(","));
  check("every student starts unmarked (status null)",
    students.every((s) => s.status === null), JSON.stringify(students.map((s) => s.status)));

  console.log("2. Marking, and re-marking in place");
  const first = await mark(cls.id, coachToken, [
    { userId: s1.id, status: "PRESENT" },
    { userId: s2.id, status: "ABSENT", note: "informed in advance" },
  ]);
  check("marking two students succeeds", first.status === 200 && first.body?.marked === 2,
    `${first.status} ${JSON.stringify(first.body)}`);

  let after = await getRoster(cls.id, coachToken);
  let rows: Array<{ id: string; status: string | null }> = after.body?.students ?? [];
  check("two are marked and one is still null",
    rows.filter((r) => r.status !== null).length === 2 && rows.filter((r) => r.status === null).length === 1,
    JSON.stringify(rows.map((r) => r.status)));

  await mark(cls.id, coachToken, [{ userId: s1.id, status: "LATE" }]);
  const dbRows = await db.classAttendance.count({ where: { classId: cls.id, userId: s1.id } });
  check("re-marking the same student UPDATES rather than duplicating", dbRows === 1, `got ${dbRows} rows`);
  after = await getRoster(cls.id, coachToken);
  rows = after.body?.students ?? [];
  check("the new status replaced the old one",
    rows.find((r) => r.id === s1.id)?.status === "LATE",
    String(rows.find((r) => r.id === s1.id)?.status));

  console.log("3. Only this class's coach (or staff) may touch it");
  const outsider = await getRoster(cls.id, tokenFor(otherCoach));
  check("another coach gets 404, not 403", outsider.status === 404, `got ${outsider.status}`);
  const studentTry = await mark(cls.id, tokenFor(s1), [{ userId: s2.id, status: "PRESENT" }]);
  check("an enrolled student cannot mark attendance", studentTry.status === 404,
    `got ${studentTry.status}`);
  const noAuth = await fetch(`${BASE}/api/attendance?classId=${cls.id}`);
  check("no cookie is 401", noAuth.status === 401, `got ${noAuth.status}`);

  console.log("4. Invalid input is rejected");
  const bad = await mark(cls.id, coachToken, [{ userId: s1.id, status: "MAYBE" }]);
  check("an unknown status is a 400", bad.status === 400, `got ${bad.status}`);

  await cleanup();
  console.log(`\n${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`} (${pass} passed) — test data removed`);
}

main()
  .then(() => process.exit(fail === 0 ? 0 : 1))
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => {});
    process.exit(1);
  });
