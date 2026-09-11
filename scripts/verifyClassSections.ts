/**
 * A class that ended is not "upcoming", and a coach only schedules for their own.
 *
 *   npm run dev            # in another terminal
 *   npx tsx --env-file=.env.local scripts/verifyClassSections.ts
 *
 * The bug: the classes list filtered on `endsAt >= now` alone, with no regard for
 * status. So a coach pressed End class, watched the room close, and then saw the
 * same class still advertised under "Upcoming" until its scheduled finish time
 * passed. Status now decides the bucket, and the clock only breaks ties.
 *
 * The subtle case worth its own assertion is the class nobody ever started. Its
 * time has passed and it is still SCHEDULED — that belongs in "ended", not
 * "upcoming", because nobody is going to attend it now and leaving it there
 * buries the classes that really are next. It is counted separately for the head
 * as "not started", since a coach who never showed up is a different fact from
 * one who taught.
 *
 * Also covers the rule the academy asked for: a coach may schedule for batches
 * they coach and nobody else's; anything academy-wide is the head's.
 *
 * Self-cleaning on every exit path.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { signAccessToken } from "../src/lib/auth";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const TAG = "kcasec";

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
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.coachProfile.deleteMany({ where: { userId: { in: ids } } });
    await db.studentProfile.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}

type Actor = { id: string; username: string; role: string };
const cookie = (a: Actor) => ({
  Cookie: `kca_access_token=${signAccessToken({ userId: a.id, username: a.username, role: a.role as never })}`,
});

const HOUR = 3600_000;

async function main() {
  await cleanup();

  let mobile = Number(`9${Date.now().toString().slice(-9)}`);
  const mk = async (suffix: string, role: "STUDENT" | "COACH" | "HEAD"): Promise<Actor> =>
    db.user.create({
      data: {
        username: `${TAG}${suffix}`,
        email: `${TAG}${suffix}@example.com`,
        mobile: String(mobile++),
        passwordHash: "x",
        role,
        ...(role === "STUDENT" ? { studentProfile: { create: {} } } : {}),
        ...(role === "COACH" ? { coachProfile: { create: {} } } : {}),
      },
      select: { id: true, username: true, role: true },
    });

  const coach = await mk("coach", "COACH");
  const otherCoach = await mk("other", "COACH");
  const head = await mk("head", "HEAD");
  const student = await mk("stu", "STUDENT");

  const mine = await db.coachProfile.findUnique({ where: { userId: coach.id }, select: { id: true } });
  const theirs = await db.coachProfile.findUnique({ where: { userId: otherCoach.id }, select: { id: true } });
  const batch = await db.batch.create({ data: { name: `${TAG} batch`, coachId: mine!.id }, select: { id: true } });
  const otherBatch = await db.batch.create({ data: { name: `${TAG} other`, coachId: theirs!.id }, select: { id: true } });
  await db.classEnrollment.create({ data: { batchId: batch.id, userId: student.id } });

  const now = Date.now();
  const mkClass = async (name: string, status: "SCHEDULED" | "ONGOING" | "COMPLETED" | "CANCELLED", startOffset: number) =>
    db.class.create({
      data: {
        title: `${TAG} ${name}`,
        coachId: mine!.id,
        batchId: batch.id,
        status,
        startsAt: new Date(now + startOffset),
        endsAt: new Date(now + startOffset + HOUR),
      },
      select: { id: true },
    });

  // The case that broke: ENDED but its scheduled finish is still in the future.
  const endedEarly = await mkClass("endedEarly", "COMPLETED", 0);
  const live = await mkClass("live", "ONGOING", -0.5 * HOUR);
  const future = await mkClass("future", "SCHEDULED", 48 * HOUR);
  // Scheduled, time passed, never started.
  const neverStarted = await mkClass("neverStarted", "SCHEDULED", -48 * HOUR);
  const cancelled = await mkClass("cancelled", "CANCELLED", 72 * HOUR);

  const list = async (a: Actor) => {
    const res = await fetch(`${BASE}/api/classes`, { headers: cookie(a) });
    const body = await res.json().catch(() => ({}));
    const ids = (k: string) => ((body[k] ?? []) as { id: string }[]).map((c) => c.id);
    return { status: res.status, ongoing: ids("ongoing"), upcoming: ids("upcoming"), ended: ids("ended") };
  };

  console.log("1. The coach's three sections");
  const asCoach = await list(coach);
  check("the list loads", asCoach.status === 200, `got ${asCoach.status}`);
  check("an ENDED class is NOT upcoming, even though its clock has not run out",
    !asCoach.upcoming.includes(endedEarly.id), "still in upcoming");
  check("it is in ended", asCoach.ended.includes(endedEarly.id));
  check("the live class is in ongoing", asCoach.ongoing.includes(live.id));
  check("and is not in upcoming", !asCoach.upcoming.includes(live.id));
  check("the future class is upcoming", asCoach.upcoming.includes(future.id));
  check("a class nobody started, whose time has passed, is ended",
    asCoach.ended.includes(neverStarted.id) && !asCoach.upcoming.includes(neverStarted.id));
  check("a cancelled class is ended, not upcoming",
    asCoach.ended.includes(cancelled.id) && !asCoach.upcoming.includes(cancelled.id));

  console.log("2. The same buckets for a student in that batch");
  const asStudent = await list(student);
  check("the student sees the live class", asStudent.ongoing.includes(live.id));
  check("and the upcoming one", asStudent.upcoming.includes(future.id));
  check("and does NOT see the ended one as upcoming", !asStudent.upcoming.includes(endedEarly.id));

  console.log("3. An unrelated coach sees none of it");
  const asOther = await list(otherCoach);
  const allOthers = [...asOther.ongoing, ...asOther.upcoming, ...asOther.ended];
  check("another coach sees none of these classes",
    ![endedEarly.id, live.id, future.id].some((id) => allOthers.includes(id)));

  console.log("4. A coach schedules only for their own batch");
  const schedule = async (a: Actor, batchId: string, coachUserId?: string) => {
    const res = await fetch(`${BASE}/api/classes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...cookie(a) },
      body: JSON.stringify({
        title: `${TAG} created`,
        batchId,
        ...(coachUserId ? { coachUserId } : {}),
        startsAt: new Date(now + 96 * HOUR).toISOString(),
        endsAt: new Date(now + 97 * HOUR).toISOString(),
      }),
    });
    return res.status;
  };

  check("a coach can schedule for their OWN batch", (await schedule(coach, batch.id)) < 400);
  check("a coach cannot schedule for someone else's batch (404)",
    (await schedule(coach, otherBatch.id)) === 404);
  check("a coach cannot assign the class to a different coach",
    (await schedule(coach, batch.id, otherCoach.id)) >= 400);
  check("the head can schedule for ANY batch", (await schedule(head, otherBatch.id)) < 400);
  check("a student cannot schedule at all", (await schedule(student, batch.id)) === 403);

  console.log("5. The head can see how much each coach has taught");
  const activity = await fetch(`${BASE}/api/admin/coach-activity`, { headers: cookie(head) });
  const body = await activity.json().catch(() => ({}));
  check("the head can read coach activity", activity.status === 200, `got ${activity.status}`);
  const row = (body.coaches ?? []).find((c: { username: string }) => c.username === coach.username);
  check("our coach appears", Boolean(row), JSON.stringify((body.coaches ?? []).map((c: { username: string }) => c.username)));
  check("completed counts the class they ENDED", row?.completed === 1, String(row?.completed));
  check("ongoing counts the live one", row?.ongoing === 1, String(row?.ongoing));
  check("'not started' is counted separately from completed", row?.missed === 1, String(row?.missed));
  check("their batch and student counts are right",
    row?.batches === 1 && row?.students === 1, `batches=${row?.batches} students=${row?.students}`);

  const asStudentActivity = await fetch(`${BASE}/api/admin/coach-activity`, { headers: cookie(student) });
  check("a student cannot read coach activity", asStudentActivity.status === 403,
    `got ${asStudentActivity.status}`);
  const anon = await fetch(`${BASE}/api/admin/coach-activity`);
  check("no cookie is 401", anon.status === 401, `got ${anon.status}`);

  console.log("6. The coach reaches the scheduling page, and sees only their own batches");
  const page = async (a: Actor, path: string) =>
    (await fetch(`${BASE}${path}`, { headers: cookie(a), redirect: "manual" })).status;
  check("a coach can open /dashboard/schedule", (await page(coach, "/dashboard/schedule")) === 200,
    `got ${await page(coach, "/dashboard/schedule")}`);
  check("a student still cannot", [302, 307].includes(await page(student, "/dashboard/schedule")));

  const batchesFor = async (a: Actor) => {
    const res = await fetch(`${BASE}/api/batches`, { headers: cookie(a) });
    const b = await res.json().catch(() => ({}));
    return ((b.batches ?? []) as { id: string }[]).map((x) => x.id);
  };
  const coachBatches = await batchesFor(coach);
  check("the coach's batch list contains their own", coachBatches.includes(batch.id));
  check("and NOT another coach's", !coachBatches.includes(otherBatch.id));
  check("the head sees both", (await batchesFor(head)).includes(otherBatch.id));
  // A coach forms their own groups, but never under a colleague's name. The full
  // authority matrix is scripts/verifyCoachAuthority.ts; this is the seam where
  // the scheduling page and that rule meet.
  const madeBatch = await fetch(`${BASE}/api/batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookie(coach) },
    body: JSON.stringify({ name: `${TAG} own group`, coachUserId: otherCoach.id }),
  });
  check("a coach can create a batch", madeBatch.status < 400, `got ${madeBatch.status}`);
  const madeId = (await madeBatch.json().catch(() => ({}))).batch?.id;
  const owner = madeId
    ? await db.batch.findUnique({ where: { id: madeId }, select: { coachId: true } })
    : null;
  check("and it is theirs, not the coach they named", owner?.coachId === mine!.id,
    `${owner?.coachId} vs ${mine!.id}`);
  check("it then appears in their own batch list", (await batchesFor(coach)).includes(madeId));

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
