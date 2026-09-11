/**
 * The head can run any class, and a class's roster can be changed from inside it.
 *
 *   npm run dev            # in another terminal
 *   npx tsx --env-file=.env.local scripts/verifyClassManage.ts
 *
 * Two problems this covers.
 *
 * **The head could not run a class they did not coach.** The room gated its
 * controls on `isCoach` — strictly the assigned coach — while the attendance and
 * enrolment APIs already allowed HR and HEAD. So the head saw no Start class
 * button and no attendance panel for buttons the server would have accepted. The
 * room now reports `canManage`, which is the same rule the APIs use.
 *
 * **A student who turned up unenrolled could not be marked.** Attendance builds
 * its roster from enrolments, and the only way to enrol was the Scheduling page —
 * not somewhere a coach goes mid-lesson. Adding them from the room closes that.
 *
 * The negative assertions matter as much: an unrelated coach and a student must
 * not be able to change a class's roster, and must get 404 rather than 403 so
 * class ids stay unprobeable.
 *
 * Self-cleaning on every exit path.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { signAccessToken } from "../src/lib/auth";
import { canAccess } from "../src/lib/socket/handlers/classHandlers";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const TAG = "kcacm";

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

async function main() {
  await cleanup();

  let mobile = Number(`9${Date.now().toString().slice(-9)}`);
  const mk = async (suffix: string, role: "STUDENT" | "COACH" | "HR" | "HEAD"): Promise<Actor> =>
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
  const staff = await mk("staff", "HR");
  const enrolled = await mk("stu1", "STUDENT");
  const walkIn = await mk("stu2", "STUDENT");

  const coachProfile = await db.coachProfile.findUnique({ where: { userId: coach.id }, select: { id: true } });
  const batch = await db.batch.create({ data: { name: `${TAG} batch`, coachId: coachProfile!.id }, select: { id: true } });
  const cls = await db.class.create({
    data: {
      title: `${TAG} class`,
      coachId: coachProfile!.id,
      batchId: batch.id,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 3600_000),
    },
    select: { id: true },
  });
  await db.classEnrollment.create({ data: { batchId: batch.id, userId: enrolled.id } });

  const room = async (a: Actor) => {
    const res = await fetch(`${BASE}/api/classes/${cls.id}/room`, { headers: cookie(a) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  console.log("1. Who can manage the room");
  const asCoach = await room(coach);
  check("the assigned coach can manage it", asCoach.body?.canManage === true, JSON.stringify(asCoach.body?.canManage));
  check("and is flagged as the coach", asCoach.body?.isCoach === true);

  const asHead = await room(head);
  check("the HEAD can manage a class they do not coach", asHead.body?.canManage === true,
    `${asHead.status} ${JSON.stringify(asHead.body?.canManage)}`);
  check("but is NOT flagged as the coach", asHead.body?.isCoach === false, String(asHead.body?.isCoach));

  const asStaff = await room(staff);
  check("HR can manage it too", asStaff.body?.canManage === true, String(asStaff.body?.canManage));

  const asStudent = await room(enrolled);
  check("an enrolled student can open the room", asStudent.status === 200, `got ${asStudent.status}`);
  check("but cannot manage it", asStudent.body?.canManage === false, String(asStudent.body?.canManage));

  const asOutsider = await room(otherCoach);
  check("an unrelated coach gets 404", asOutsider.status === 404, `got ${asOutsider.status}`);

  console.log("2. The head can start and end a class they do not coach");
  const start = await fetch(`${BASE}/api/classes/${cls.id}/room`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookie(head) },
    body: JSON.stringify({ action: "start" }),
  });
  check("HEAD can start it", start.status === 200, `got ${start.status}`);
  check("the class is now ONGOING",
    (await db.class.findUnique({ where: { id: cls.id }, select: { status: true } }))?.status === "ONGOING");

  const studentStart = await fetch(`${BASE}/api/classes/${cls.id}/room`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookie(enrolled) },
    body: JSON.stringify({ action: "end" }),
  });
  check("a student cannot end it", studentStart.status === 403, `got ${studentStart.status}`);

  console.log("3. Adding a student from inside the class");
  const enroll = async (a: Actor, studentUserId: string) => {
    const res = await fetch(`${BASE}/api/classes/${cls.id}/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...cookie(a) },
      body: JSON.stringify({ studentUserId }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const byOutsider = await enroll(otherCoach, walkIn.id);
  check("an unrelated coach cannot add anyone (404)", byOutsider.status === 404, `got ${byOutsider.status}`);
  const byStudent = await enroll(enrolled, walkIn.id);
  check("a student cannot add anyone (404)", byStudent.status === 404, `got ${byStudent.status}`);
  check("nobody was added by those attempts",
    (await db.classEnrollment.count({ where: { userId: walkIn.id } })) === 0);

  const byHead = await enroll(head, walkIn.id);
  check("the HEAD can add a walk-in", byHead.status === 200, `${byHead.status} ${JSON.stringify(byHead.body)}`);
  check("the enrolment is on the CLASS, not the batch",
    (await db.classEnrollment.count({ where: { userId: walkIn.id, classId: cls.id } })) === 1);
  check("they were NOT silently added to the batch",
    (await db.classEnrollment.count({ where: { userId: walkIn.id, batchId: batch.id } })) === 0);

  console.log("4. The walk-in is now markable");
  const roster = await fetch(`${BASE}/api/attendance?classId=${cls.id}`, { headers: cookie(head) });
  const rosterBody = await roster.json().catch(() => ({}));
  const ids: string[] = (rosterBody.students ?? []).map((s: { id: string }) => s.id);
  check("the attendance roster includes the walk-in", ids.includes(walkIn.id), ids.join(","));
  check("and still includes the batch-enrolled student", ids.includes(enrolled.id), ids.join(","));

  const mark = await fetch(`${BASE}/api/attendance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookie(head) },
    body: JSON.stringify({ classId: cls.id, entries: [{ userId: walkIn.id, status: "PRESENT" }] }),
  });
  check("the HEAD can mark them present", mark.status === 200, `got ${mark.status}`);

  console.log("5. Adding twice is harmless");
  const again = await enroll(coach, walkIn.id);
  check("re-adding reports alreadyEnrolled", again.status === 200 && again.body?.alreadyEnrolled === true,
    JSON.stringify(again.body));
  check("and does not duplicate the row",
    (await db.classEnrollment.count({ where: { userId: walkIn.id, classId: cls.id } })) === 1);

  const batchStudent = await enroll(coach, enrolled.id);
  check("a batch-enrolled student is recognised as already in", batchStudent.body?.alreadyEnrolled === true,
    JSON.stringify(batchStudent.body));

  console.log("5b. A coach can add a walk-in they do not already teach, by username");
  const walkIn2 = await mk("stu3", "STUDENT");
  const byName = await fetch(`${BASE}/api/classes/${cls.id}/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookie(coach) },
    body: JSON.stringify({ username: walkIn2.username }),
  });
  check("the coach can add a stranger by exact username", byName.status === 200, `got ${byName.status}`);
  check("they are now enrolled",
    (await db.classEnrollment.count({ where: { userId: walkIn2.id, classId: cls.id } })) === 1);

  const wrongCase = await mk("stu4", "STUDENT");
  const caseRes = await fetch(`${BASE}/api/classes/${cls.id}/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookie(coach) },
    body: JSON.stringify({ username: wrongCase.username.toUpperCase() }),
  });
  check("username matching is case-insensitive", caseRes.status === 200, `got ${caseRes.status}`);

  const nobody = await fetch(`${BASE}/api/classes/${cls.id}/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookie(coach) },
    body: JSON.stringify({ username: `${TAG}doesnotexist` }),
  });
  check("an unknown username is a 404", nobody.status === 404, `got ${nobody.status}`);
  const partial = await fetch(`${BASE}/api/classes/${cls.id}/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookie(coach) },
    body: JSON.stringify({ username: TAG }),
  });
  check("a PARTIAL username matches nobody (no enumeration)", partial.status === 404, `got ${partial.status}`);

  const strangerAdds = await fetch(`${BASE}/api/classes/${cls.id}/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookie(enrolled) },
    body: JSON.stringify({ username: walkIn2.username }),
  });
  check("a student still cannot add by username either", strangerAdds.status === 404,
    `got ${strangerAdds.status}`);

  console.log("6. Only real, active students can be added");
  const notAStudent = await enroll(head, otherCoach.id);
  check("a coach cannot be added as a student", notAStudent.status === 404, `got ${notAStudent.status}`);

  console.log("7. The SOCKET agrees with the HTTP route about who belongs");
  // These two drifted once and the symptom was awful to diagnose: the room page
  // rendered every control for the head, and then the video answered "forbidden"
  // because the socket used a narrower rule. Assert them together.
  check("the coach may join over the socket", await canAccess(cls.id, coach.id, coach.role));
  check("the HEAD may join over the socket", await canAccess(cls.id, head.id, head.role));
  check("HR may join over the socket", await canAccess(cls.id, staff.id, staff.role));
  check("the enrolled student may join", await canAccess(cls.id, enrolled.id, enrolled.role));
  check("an unrelated coach may NOT", !(await canAccess(cls.id, otherCoach.id, otherCoach.role)));
  const stranger = await mk("stranger", "STUDENT");
  check("an unenrolled student may NOT", !(await canAccess(cls.id, stranger.id, stranger.role)));

  console.log("8. The head can reach the training tools");
  for (const path of ["/dashboard/analysis", "/dashboard/puzzles", "/dashboard/games", "/dashboard/roster"]) {
    const res = await fetch(`${BASE}${path}`, { headers: cookie(head), redirect: "manual" });
    check(`HEAD can open ${path}`, res.status === 200, `got ${res.status}`);
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
