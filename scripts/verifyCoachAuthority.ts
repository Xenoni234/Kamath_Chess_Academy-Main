/**
 * A coach commands their own teaching. The head commands everything. Neither
 * changes who can see the money.
 *
 *   npm run dev            # in another terminal
 *   npx tsx --env-file=.env.local scripts/verifyCoachAuthority.ts
 *
 * The academy's rule is "give the coach the same control as the head, but only
 * for teaching, and the head can override anyone". That is three claims, and each
 * fails in a different direction:
 *
 *   1. Too little — a coach who cannot cancel their own class has to ask staff to
 *      do it, which is the situation this replaces. There was no cancel route at
 *      ALL until now, for anyone.
 *   2. Too much — "same as the head" must not quietly mean "over other coaches'
 *      batches", or one teacher can rearrange another's week.
 *   3. Wrong axis — teaching authority must not drag financial authority along
 *      with it. A coach with full command of a class still must not learn whether
 *      that child's family is behind on fees.
 *
 * The head-override assertions are the ones worth reading: the head acts on a
 * class they did not create, coach or teach, and it works.
 *
 * Self-cleaning on every exit path.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { signAccessToken } from "../src/lib/auth";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const TAG = "kcaauth";

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
  const batches = await db.batch.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const classes = await db.class.findMany({
    where: { OR: [{ title: { startsWith: TAG } }, { batchId: { in: batches.map((b) => b.id) } }] },
    select: { id: true },
  });
  await db.classAttendance.deleteMany({ where: { classId: { in: classes.map((c) => c.id) } } });
  await db.classEnrollment.deleteMany({
    where: { OR: [{ userId: { in: ids } }, { batchId: { in: batches.map((b) => b.id) } }] },
  });
  await db.class.deleteMany({ where: { id: { in: classes.map((c) => c.id) } } });
  await db.batch.deleteMany({ where: { name: { startsWith: TAG } } });
  if (ids.length) {
    const payments = await db.payment.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    await db.invoice.deleteMany({ where: { paymentId: { in: payments.map((p) => p.id) } } });
    await db.payment.deleteMany({ where: { userId: { in: ids } } });
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
const json = (a: Actor) => ({ "Content-Type": "application/json", ...cookie(a) });
const HOUR = 3600_000;

async function main() {
  await cleanup();

  let mobile = Number(`9${Date.now().toString().slice(-9)}`);
  const mk = async (suffix: string, role: "STUDENT" | "COACH" | "HEAD" | "HR"): Promise<Actor> =>
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
  const rival = await mk("rival", "COACH");
  const head = await mk("head", "HEAD");
  const student = await mk("stu", "STUDENT");
  const walkIn = await mk("walk", "STUDENT");

  const mine = await db.coachProfile.findUnique({ where: { userId: coach.id }, select: { id: true } });
  const theirs = await db.coachProfile.findUnique({ where: { userId: rival.id }, select: { id: true } });
  const rivalBatch = await db.batch.create({
    data: { name: `${TAG} rival batch`, coachId: theirs!.id },
    select: { id: true },
  });

  console.log("1. A coach forms their own batch — under their own name, never someone else's");
  const madeRes = await fetch(`${BASE}/api/batches`, {
    method: "POST",
    headers: json(coach),
    // Deliberately tries to create it under the rival's name.
    body: JSON.stringify({ name: `${TAG} my batch`, coachUserId: rival.id }),
  });
  const madeBody = await madeRes.json().catch(() => ({}));
  check("a coach can create a batch", madeRes.status < 400, `got ${madeRes.status}`);
  const batchId: string = madeBody.batch?.id;
  const createdBatch = batchId
    ? await db.batch.findUnique({ where: { id: batchId }, select: { coachId: true } })
    : null;
  check("and it belongs to THEM, not the coach they named", createdBatch?.coachId === mine!.id,
    `coachId=${createdBatch?.coachId} expected=${mine!.id}`);

  console.log("2. They enrol their own students by name — with no student directory");
  const dir = await fetch(`${BASE}/api/users?role=STUDENT`, { headers: cookie(coach) });
  check("a coach still cannot list the academy's students", dir.status === 403, `got ${dir.status}`);
  const enrol = async (a: Actor, target: string, body: Record<string, unknown>) =>
    fetch(`${BASE}/api/batches/${target}/enroll`, { method: "POST", headers: json(a), body: JSON.stringify(body) });
  check("a coach enrols into their OWN batch by username",
    (await enrol(coach, batchId, { username: student.username })).status < 400);
  check("a second student too", (await enrol(coach, batchId, { username: walkIn.username })).status < 400);
  check("a made-up name is refused", (await enrol(coach, batchId, { username: "nobodyxyz" })).status === 404);
  check("a coach CANNOT enrol into a rival's batch (404)",
    (await enrol(coach, rivalBatch.id, { username: student.username })).status === 404);

  console.log("3. They may rename their batch, but never hand it to another coach");
  const patchBatch = async (a: Actor, target: string, body: Record<string, unknown>) =>
    (await fetch(`${BASE}/api/batches/${target}`, { method: "PATCH", headers: json(a), body: JSON.stringify(body) }))
      .status;
  check("a coach renames their own batch", (await patchBatch(coach, batchId, { name: `${TAG} renamed` })) < 400);
  check("a coach cannot reassign the coach (403)",
    (await patchBatch(coach, batchId, { coachUserId: rival.id })) === 403);
  check("a coach cannot rename a rival's batch (404)",
    (await patchBatch(coach, rivalBatch.id, { name: `${TAG} stolen` })) === 404);
  const stillMine = await db.batch.findUnique({ where: { id: batchId }, select: { coachId: true } });
  check("the batch is still theirs after all that", stillMine?.coachId === mine!.id);

  console.log("4. They schedule, move and cancel their own class");
  const createClass = async (a: Actor, target: string, extra: Record<string, unknown> = {}) => {
    const res = await fetch(`${BASE}/api/classes`, {
      method: "POST",
      headers: json(a),
      body: JSON.stringify({
        batchId: target,
        title: `${TAG} session`,
        startsAt: new Date(Date.now() + 24 * HOUR).toISOString(),
        endsAt: new Date(Date.now() + 25 * HOUR).toISOString(),
        ...extra,
      }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const own = await createClass(coach, batchId);
  check("a coach schedules into their own batch", own.status < 400, `got ${own.status}`);
  const classId: string = own.body.class?.id;

  const patchClass = async (a: Actor, target: string, body: Record<string, unknown>) =>
    (await fetch(`${BASE}/api/classes/${target}`, { method: "PATCH", headers: json(a), body: JSON.stringify(body) }))
      .status;
  check("they can retitle it", (await patchClass(coach, classId, { title: `${TAG} moved` })) < 400);
  check("they can move it", (await patchClass(coach, classId, {
    startsAt: new Date(Date.now() + 48 * HOUR).toISOString(),
    endsAt: new Date(Date.now() + 49 * HOUR).toISOString(),
  })) < 400);
  check("an end before its start is refused", (await patchClass(coach, classId, {
    startsAt: new Date(Date.now() + 48 * HOUR).toISOString(),
    endsAt: new Date(Date.now() + 47 * HOUR).toISOString(),
  })) === 400);
  check("a student cannot touch it (404)", (await patchClass(student, classId, { title: "hacked" })) === 404);

  const rivalClass = await db.class.create({
    data: {
      title: `${TAG} rival session`,
      coachId: theirs!.id,
      batchId: rivalBatch.id,
      status: "SCHEDULED",
      startsAt: new Date(Date.now() + 24 * HOUR),
      endsAt: new Date(Date.now() + 25 * HOUR),
    },
    select: { id: true },
  });
  check("a coach cannot edit a RIVAL's class (404)",
    (await patchClass(coach, rivalClass.id, { title: `${TAG} stolen` })) === 404);
  check("nor cancel it", (await patchClass(coach, rivalClass.id, { status: "CANCELLED" })) === 404);

  console.log("5. THE OVERRIDE — the head acts on a class that is not theirs");
  check("the head retitles another coach's class",
    (await patchClass(head, rivalClass.id, { title: `${TAG} head says so` })) < 400);
  check("the head cancels another coach's class",
    (await patchClass(head, rivalClass.id, { status: "CANCELLED" })) < 400);
  const overridden = await db.class.findUnique({ where: { id: rivalClass.id }, select: { status: true, title: true } });
  check("and it really is cancelled", overridden?.status === "CANCELLED", String(overridden?.status));
  check("the head's edit stuck", overridden?.title === `${TAG} head says so`, String(overridden?.title));
  const overrideLog = await db.auditLog.findFirst({
    where: { userId: head.id, action: "class.cancel" },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  check("the override is recorded as an override",
    (overrideLog?.metadata as { override?: boolean } | null)?.override === true,
    JSON.stringify(overrideLog?.metadata));
  check("the head reassigns a batch to a different coach",
    (await patchBatch(head, batchId, { coachUserId: rival.id })) < 400);
  await db.batch.update({ where: { id: batchId }, data: { coachId: mine!.id } });

  console.log("6. Deleting is the head's alone — a coach cancels, and cancelling is not deleting");
  const del = async (a: Actor, target: string) =>
    (await fetch(`${BASE}/api/classes/${target}`, { method: "DELETE", headers: cookie(a) })).status;
  check("a coach cannot delete even their own class", (await del(coach, classId)) === 403);
  check("a student cannot delete", (await del(student, classId)) === 403);
  check("their class still exists", Boolean(await db.class.findUnique({ where: { id: classId } })));
  check("the head can delete", (await del(head, classId)) === 200);
  check("and it is gone", (await db.class.findUnique({ where: { id: classId } })) === null);

  console.log("7. A taught class is history and cannot be rewritten");
  const taught = await db.class.create({
    data: {
      title: `${TAG} taught`,
      coachId: mine!.id,
      batchId,
      status: "COMPLETED",
      startsAt: new Date(Date.now() - 3 * HOUR),
      endsAt: new Date(Date.now() - 2 * HOUR),
    },
    select: { id: true },
  });
  check("a coach cannot retitle a completed class (409)",
    (await patchClass(coach, taught.id, { title: `${TAG} rewritten` })) === 409);
  check("neither can the head — the record is the record",
    (await patchClass(head, taught.id, { title: `${TAG} rewritten` })) === 409);
  check("a class cannot be marked COMPLETED by PATCH at all",
    (await patchClass(head, rivalClass.id, { status: "COMPLETED" })) === 400);

  console.log("8. None of this gave the coach a single rupee");
  await db.payment.create({
    data: { userId: student.id, amount: 7500, status: "PENDING", description: `${TAG} term fees` },
  });
  const overview = await fetch(`${BASE}/api/students/${student.id}/overview`, { headers: cookie(coach) });
  const ov = await overview.json().catch(() => ({}));
  check("the coach can still see their student", overview.status === 200, `got ${overview.status}`);
  check("but showMoney is false", ov.showMoney === false, String(ov.showMoney));
  check("and the amount appears nowhere", !JSON.stringify(ov).includes("7500"), "7500 leaked");
  check("the payments API refuses them (404)",
    (await fetch(`${BASE}/api/payments?userId=${student.id}`, { headers: cookie(coach) })).status === 404);
  check("the ledger refuses them", (await fetch(`${BASE}/api/payments`, { headers: cookie(coach) })).status >= 400);
  const recordMoney = await fetch(`${BASE}/api/payments`, {
    method: "POST",
    headers: json(coach),
    body: JSON.stringify({ userId: student.id, amount: 100, status: "PENDING", description: `${TAG} probe` }),
  });
  check("and they cannot record a payment (403)", recordMoney.status === 403, `got ${recordMoney.status}`);
  const feeConsole = await fetch(`${BASE}/dashboard/admin/payments`, { headers: cookie(coach), redirect: "manual" });
  check("the fee console redirects them away", [302, 307].includes(feeConsole.status), `got ${feeConsole.status}`);

  console.log("9. Nor any of the head's academy-wide powers");
  const forbidden: [string, string][] = [
    ["create staff accounts", "/api/admin/users"],
    ["read the audit log", "/api/admin/audit"],
    ["mint invite codes", "/api/admin/invite-codes"],
    ["read enquiries", "/api/admin/contact"],
  ];
  for (const [label, path] of forbidden) {
    const res = await fetch(`${BASE}${path}`, { headers: cookie(coach) });
    check(`a coach cannot ${label}`, res.status === 403, `got ${res.status}`);
  }

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
