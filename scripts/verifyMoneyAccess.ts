/**
 * A coach cannot see what a family pays. Nor can HR. Only the head.
 *
 *   npm run dev            # in another terminal
 *   npx tsx --env-file=.env.local scripts/verifyMoneyAccess.ts
 *
 * The leak this closes: every money surface used `canViewStudent`, which admits
 * coaches — correctly, since a coach needs their students' games, attendance and
 * progress. Money is not that. Whether a child's fees are overdue is between the
 * family and the academy's owner, and a coach knowing it colours how they treat
 * the child. So fees, invoices and payment history now use `canViewMoney`: the
 * head, the student themselves, and a linked parent.
 *
 * Reading and managing are separate. A student may see their own fees and must
 * never be able to mark them paid.
 *
 * The most valuable assertion here is the quiet one — that a coach's view of a
 * student omits the money rather than showing ₹0. Zero reads as "this family owes
 * nothing", which is a false statement about a family's finances.
 *
 * Self-cleaning on every exit path.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { signAccessToken } from "../src/lib/auth";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const TAG = "kcamoney";

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
  if (ids.length) {
    const payments = await db.payment.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    await db.invoice.deleteMany({ where: { paymentId: { in: payments.map((p) => p.id) } } });
    await db.payment.deleteMany({ where: { userId: { in: ids } } });
    await db.parentStudent.deleteMany({ where: { OR: [{ parentId: { in: ids } }, { studentId: { in: ids } }] } });
    await db.classEnrollment.deleteMany({ where: { userId: { in: ids } } });
    await db.class.deleteMany({ where: { title: { startsWith: TAG } } });
    await db.batch.deleteMany({ where: { name: { startsWith: TAG } } });
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

async function main() {
  await cleanup();

  let mobile = Number(`9${Date.now().toString().slice(-9)}`);
  const mk = async (suffix: string, role: "STUDENT" | "PARENT" | "COACH" | "HR" | "HEAD"): Promise<Actor> =>
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

  const student = await mk("stu", "STUDENT");
  const parent = await mk("par", "PARENT");
  const coach = await mk("coa", "COACH");
  const hr = await mk("hr", "HR");
  const head = await mk("head", "HEAD");
  const otherStudent = await mk("other", "STUDENT");

  await db.parentStudent.create({ data: { parentId: parent.id, studentId: student.id } });

  // Make the coach genuinely THEIR coach — that is the whole point. A coach who
  // cannot see the student at all proves nothing.
  const coachProfile = await db.coachProfile.findUnique({ where: { userId: coach.id }, select: { id: true } });
  const batch = await db.batch.create({ data: { name: `${TAG} batch`, coachId: coachProfile!.id }, select: { id: true } });
  await db.classEnrollment.create({ data: { batchId: batch.id, userId: student.id } });

  const payment = await db.payment.create({
    data: { userId: student.id, amount: 4500, status: "PENDING", description: "Term fees" },
    select: { id: true },
  });

  console.log("0. The coach really can see this student (otherwise nothing below means anything)");
  const overviewAsCoach = await fetch(`${BASE}/api/students/${student.id}/overview`, { headers: cookie(coach) });
  const coachBody = await overviewAsCoach.json().catch(() => ({}));
  check("the coach can open their student's overview", overviewAsCoach.status === 200, `got ${overviewAsCoach.status}`);
  check("and does see their chess (games key present)", "games" in coachBody);

  console.log("1. But the overview withholds the money");
  check("showMoney is false for the coach", coachBody.showMoney === false, String(coachBody.showMoney));
  check("no payment rows are returned", (coachBody.payments ?? []).length === 0,
    JSON.stringify(coachBody.payments));
  check("the amount appears nowhere in the response",
    !JSON.stringify(coachBody).includes("4500"), "4500 found in the payload");

  const overviewAsHr = await fetch(`${BASE}/api/students/${student.id}/overview`, { headers: cookie(hr) });
  const hrBody = await overviewAsHr.json().catch(() => ({}));
  check("HR is also withheld the money", hrBody.showMoney === false, String(hrBody.showMoney));
  check("and sees no amounts", !JSON.stringify(hrBody).includes("4500"));

  console.log("2. The people who should see it, do");
  for (const [label, actor] of [["the head", head], ["the student", student], ["their parent", parent]] as const) {
    const res = await fetch(`${BASE}/api/students/${student.id}/overview`, { headers: cookie(actor) });
    const body = await res.json().catch(() => ({}));
    check(`${label} sees the money`, body.showMoney === true, `${res.status} ${String(body.showMoney)}`);
    check(`${label} gets the payment row`, (body.payments ?? []).length === 1,
      JSON.stringify(body.payments?.length));
  }

  console.log("3. The payments API applies the same rule");
  const listFor = async (actor: Actor, userId: string) => {
    const res = await fetch(`${BASE}/api/payments?userId=${userId}`, { headers: cookie(actor) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const coachList = await listFor(coach, student.id);
  check("a coach asking for their own student's payments gets 404", coachList.status === 404,
    `got ${coachList.status}`);
  const hrList = await listFor(hr, student.id);
  check("HR gets 404 too", hrList.status === 404, `got ${hrList.status}`);
  const selfList = await listFor(student, student.id);
  check("the student sees their own", selfList.status === 200 && (selfList.body.payments ?? []).length === 1,
    `${selfList.status}`);
  const parentList = await listFor(parent, student.id);
  check("the parent sees their child's", parentList.status === 200, `got ${parentList.status}`);
  const headList = await listFor(head, student.id);
  check("the head sees it", headList.status === 200, `got ${headList.status}`);
  const nosyStudent = await listFor(student, otherStudent.id);
  check("a student cannot read ANOTHER student's fees", nosyStudent.status === 404, `got ${nosyStudent.status}`);

  console.log("4. The whole ledger is the head's alone");
  for (const [label, actor] of [["a coach", coach], ["HR", hr], ["a student", student]] as const) {
    const res = await fetch(`${BASE}/api/payments`, { headers: cookie(actor) });
    check(`${label} cannot list the whole ledger`, res.status >= 400, `got ${res.status}`);
  }
  const headAll = await fetch(`${BASE}/api/payments`, { headers: cookie(head) });
  check("the head can", headAll.status === 200, `got ${headAll.status}`);

  console.log("5. Only the head may RECORD or CHANGE money");
  const record = async (actor: Actor) =>
    (
      await fetch(`${BASE}/api/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...cookie(actor) },
        body: JSON.stringify({ userId: student.id, amount: 100, status: "PENDING", description: `${TAG} probe` }),
      })
    ).status;
  check("a coach cannot record a payment", (await record(coach)) === 403);
  check("HR cannot record a payment", (await record(hr)) === 403);
  check("a student cannot record their own", (await record(student)) === 403);
  check("a parent cannot either", (await record(parent)) === 403);
  check("the head can", (await record(head)) === 201);

  const settle = async (actor: Actor) =>
    (
      await fetch(`${BASE}/api/payments/${payment.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...cookie(actor) },
        body: JSON.stringify({ status: "COMPLETED" }),
      })
    ).status;
  check("a student cannot mark their own fee paid", (await settle(student)) === 403);
  check("HR cannot settle a payment", (await settle(hr)) === 403);
  check("the head can", (await settle(head)) === 200);

  console.log("6. The fee console is head-only");
  for (const [label, actor] of [["a coach", coach], ["HR", hr], ["a student", student]] as const) {
    const res = await fetch(`${BASE}/dashboard/admin/payments`, { headers: cookie(actor), redirect: "manual" });
    check(`${label} is redirected away from the fee console`, res.status === 307 || res.status === 302,
      `got ${res.status}`);
  }
  const headPage = await fetch(`${BASE}/dashboard/admin/payments`, { headers: cookie(head), redirect: "manual" });
  check("the head reaches it", headPage.status === 200, `got ${headPage.status}`);
  // HR must still reach the rest of the admin area — this narrowed fees, not HR.
  const hrOther = await fetch(`${BASE}/dashboard/admin/users`, { headers: cookie(hr), redirect: "manual" });
  check("HR still reaches People (only fees were narrowed)", hrOther.status === 200, `got ${hrOther.status}`);

  console.log("7. Invoices follow the money, not the student");
  const paid = await db.payment.findFirst({
    where: { userId: student.id, status: "COMPLETED" },
    select: { id: true },
  });
  if (paid) {
    const inv = async (actor: Actor) =>
      (await fetch(`${BASE}/api/payments/${paid.id}/invoice`, { headers: cookie(actor) })).status;
    // 404 either way when no invoice exists yet; what matters is that the coach's
    // refusal is the authorisation one, so assert the DB rule directly too.
    const { canViewMoney } = await import("../src/lib/authz");
    // canViewMoney takes { userId, role }; Actor carries `id`. Adapt explicitly
    // rather than passing the wrong shape — which is exactly what happened first
    // time, and produced a Prisma error about a missing `parentId`.
    const as = (a: Actor) => ({ userId: a.id, role: a.role as never });
    check("canViewMoney refuses the coach", !(await canViewMoney(as(coach), student.id)));
    check("canViewMoney refuses HR", !(await canViewMoney(as(hr), student.id)));
    check("canViewMoney allows the head", await canViewMoney(as(head), student.id));
    check("canViewMoney allows the student", await canViewMoney(as(student), student.id));
    check("canViewMoney allows their parent", await canViewMoney(as(parent), student.id));
    check("canViewMoney refuses a parent for a child that is not theirs",
      !(await canViewMoney(as(parent), otherStudent.id)));
    check("the invoice route refuses the coach", (await inv(coach)) === 404, "coach reached an invoice");
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
