/**
 * Verify the role/relationship authorization matrix end to end.
 *
 *   npx tsx --env-file=.env.local scripts/verifyRoles.ts
 *
 * Creates one throwaway user per role plus a parent→child link and a coach batch,
 * asserts who may see whom, then deletes everything it made. Requires a reachable
 * database; it writes only to accounts prefixed `verifyroles_`.
 *
 * These rules are the ones that are easy to get subtly wrong and impossible to
 * notice by clicking around: a parent seeing another family's child, or a coach
 * reading a student who is not theirs, both look like a working page.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { canViewStudent, childIdsForParent, isCoachOf, isParentOf, studentIdsForCoach } from "../src/lib/authz";
import { hashPassword } from "../src/lib/auth";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const P = "verifyroles_";
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function cleanup() {
  await db.user.deleteMany({ where: { username: { startsWith: P } } });
  await db.batch.deleteMany({ where: { name: { startsWith: P } } });
}

async function main() {
  await cleanup();
  const pw = await hashPassword("not-a-real-password-" + Date.now());
  const mk = (name: string, role: "STUDENT" | "PARENT" | "COACH" | "HR" | "HEAD") =>
    db.user.create({
      data: {
        username: `${P}${name}`,
        email: `${P}${name}@example.invalid`,
        mobile: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
        passwordHash: pw,
        role,
      },
      select: { id: true, role: true },
    });

  const [child, otherChild, parent, coach, otherCoach, hr, head] = await Promise.all([
    mk("child", "STUDENT"),
    mk("otherchild", "STUDENT"),
    mk("parent", "PARENT"),
    mk("coach", "COACH"),
    mk("othercoach", "COACH"),
    mk("hr", "HR"),
    mk("head", "HEAD"),
  ]);

  await db.parentStudent.create({ data: { parentId: parent.id, studentId: child.id } });
  const coachProfile = await db.coachProfile.create({ data: { userId: coach.id }, select: { id: true } });
  await db.coachProfile.create({ data: { userId: otherCoach.id } });
  const batch = await db.batch.create({ data: { name: `${P}batch`, coachId: coachProfile.id }, select: { id: true } });
  await db.classEnrollment.create({ data: { batchId: batch.id, userId: child.id } });

  console.log("\nParent ↔ child");
  check("parent is linked to their child", await isParentOf(parent.id, child.id));
  check("parent is NOT linked to another child", !(await isParentOf(parent.id, otherChild.id)));
  check("childIdsForParent returns exactly the child", (await childIdsForParent(parent.id)).join() === child.id);

  console.log("\nCoach ↔ student");
  check("coach owns their batch's student", await isCoachOf(coach.id, child.id));
  check("another coach does NOT", !(await isCoachOf(otherCoach.id, child.id)));
  check("coach does NOT own an unenrolled student", !(await isCoachOf(coach.id, otherChild.id)));
  check("studentIdsForCoach returns the roster", (await studentIdsForCoach(coach.id)).includes(child.id));

  console.log("\ncanViewStudent matrix");
  check("student sees themselves", await canViewStudent({ userId: child.id, role: "STUDENT" }, child.id));
  check("student does NOT see another student", !(await canViewStudent({ userId: child.id, role: "STUDENT" }, otherChild.id)));
  check("parent sees their child", await canViewStudent({ userId: parent.id, role: "PARENT" }, child.id));
  check("parent does NOT see another child", !(await canViewStudent({ userId: parent.id, role: "PARENT" }, otherChild.id)));
  check("coach sees their student", await canViewStudent({ userId: coach.id, role: "COACH" }, child.id));
  check("coach does NOT see a stranger", !(await canViewStudent({ userId: coach.id, role: "COACH" }, otherChild.id)));
  check("HR sees any student", await canViewStudent({ userId: hr.id, role: "HR" }, otherChild.id));
  check("HEAD sees any student", await canViewStudent({ userId: head.id, role: "HEAD" }, otherChild.id));

  console.log("\nRoute gating — prefix collisions");
  // "/dashboard/student-detail/<id>" used to match the "/dashboard/student" rule
  // through a raw `startsWith`, so the STUDENT-only gate fired and every coach,
  // parent and head who clicked a student was bounced to their own dashboard.
  // The page was never the problem; the router refused to let anyone reach it.
  const gated: Record<string, string[]> = {
    "/dashboard/student": ["STUDENT"],
    "/dashboard/student-detail": ["COACH", "HR", "HEAD", "PARENT"],
    "/dashboard/parent": ["PARENT"],
    "/dashboard/coach": ["COACH"],
    "/dashboard/hr": ["HR", "HEAD"],
    "/dashboard/head": ["HEAD"],
    "/dashboard/admin": ["HR", "HEAD"],
    "/dashboard/schedule": ["HR", "HEAD"],
    "/dashboard/children": ["PARENT", "HR", "HEAD"],
    "/dashboard/roster": ["COACH", "HR", "HEAD"],
  };
  /** Mirrors src/proxy.ts: whole segments, longest match wins. */
  const matchRoute = (pathname: string) =>
    Object.keys(gated)
      .filter((route) => pathname === route || pathname.startsWith(`${route}/`))
      .sort((a, b) => b.length - a.length)[0];

  check("a student detail page matches its OWN rule, not /dashboard/student",
    matchRoute("/dashboard/student-detail/abc123") === "/dashboard/student-detail",
    String(matchRoute("/dashboard/student-detail/abc123")));
  check("the student dashboard still matches its own rule",
    matchRoute("/dashboard/student") === "/dashboard/student");
  check("a nested admin path matches /dashboard/admin",
    matchRoute("/dashboard/admin/audit") === "/dashboard/admin");
  check("an unrelated path matching no rule is left alone",
    matchRoute("/dashboard/puzzles") === undefined, String(matchRoute("/dashboard/puzzles")));
  check("a path that merely SHARES a prefix is not captured",
    matchRoute("/dashboard/students") === undefined, String(matchRoute("/dashboard/students")));

  // The rule file and the real proxy must not drift apart.
  const proxySource = (await import("node:fs")).readFileSync("src/proxy.ts", "utf8");
  for (const route of Object.keys(gated)) {
    check(`proxy.ts still gates ${route}`, proxySource.includes(`"${route}"`));
  }
  check("proxy.ts matches on segments, not a raw prefix",
    proxySource.includes("pathname === route || pathname.startsWith(`${route}/`)"));

  await cleanup();
  console.log(failures === 0 ? "\n✅ ALL PASS (test accounts removed)" : `\n❌ ${failures} CHECK(S) FAILED (test accounts removed)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await cleanup().catch(() => {});
  process.exit(1);
});
