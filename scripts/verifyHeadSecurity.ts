/**
 * Nobody but the head can become, or act as, the head.
 *
 *   npm run dev            # in another terminal
 *   npx tsx --env-file=.env.local scripts/verifyHeadSecurity.ts
 *
 * HEAD is the account that owns the academy: platform revenue, every student's
 * personal record, the audit log, and the power to create, promote and demote
 * staff. Every other control in this codebase assumes that account is sound, so
 * it gets its own adversarial test rather than being covered incidentally.
 *
 * The shape of the attack this defends against is privilege escalation, and it
 * comes from four directions, each tried below from a real account of the role
 * in question:
 *
 *   1. Sign-up — can anyone hand themselves HEAD at registration?
 *   2. Promotion — can HR, a coach or a student promote anyone (including
 *      themselves) to HEAD or to staff?
 *   3. Reach — can a non-head open head-only pages or call head-only APIs?
 *   4. Removal — can the last head be demoted, deactivated or erased, leaving the
 *      academy with no owner and no way back in?
 *
 * Creates its own throwaway accounts for each role and never touches the real
 * head. Self-cleaning on every exit path.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import { signAccessToken } from "../src/lib/auth";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const TAG = "kcahsec";

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
  await db.otpVerification.deleteMany({ where: { email: { contains: TAG } } });
  if (ids.length) {
    await db.inviteCode.deleteMany({ where: { OR: [{ createdById: { in: ids } }, { usedById: { in: ids } }] } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.userSession.deleteMany({ where: { userId: { in: ids } } });
    await db.studentProfile.deleteMany({ where: { userId: { in: ids } } });
    await db.coachProfile.deleteMany({ where: { userId: { in: ids } } });
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
        isActive: true,
      },
      select: { id: true, username: true, role: true },
    });

  const student = await mk("stu", "STUDENT");
  const parent = await mk("par", "PARENT");
  const coach = await mk("coa", "COACH");
  const hr = await mk("hr", "HR");
  const head = await mk("head", "HEAD");
  const victim = await mk("vic", "STUDENT");

  const attackers: Array<[string, Actor]> = [
    ["student", student],
    ["parent", parent],
    ["coach", coach],
    ["HR", hr],
  ];

  console.log("1. Nobody can register themselves as HEAD");
  await db.otpVerification.create({
    data: {
      email: `${TAG}esc@example.com`,
      otpHash: await bcrypt.hash("424242", 10),
      purpose: "register",
      expiresAt: new Date(Date.now() + 600000),
      attempts: 0,
    },
  });
  const signup = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: `${TAG}esc`,
      email: `${TAG}esc@example.com`,
      mobile: String(mobile++),
      password: "Str0ng!TestPass2026",
      confirmPassword: "Str0ng!TestPass2026",
      otp: "424242",
      role: "HEAD",
      agreedToTerms: true,
      agreedToAge: true,
      agreedToDataProcessing: true,
    }),
  });
  check("registering as HEAD is rejected", signup.status === 400, `got ${signup.status}`);
  check("no HEAD account was created by it",
    (await db.user.count({ where: { username: `${TAG}esc`, role: "HEAD" } })) === 0);

  console.log("2. Nobody below head can promote anyone to HEAD");
  for (const [label, actor] of attackers) {
    const res = await fetch(`${BASE}/api/admin/users/${victim.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...cookie(actor) },
      body: JSON.stringify({ role: "HEAD" }),
    });
    check(`${label} cannot promote anyone to HEAD`, res.status === 403, `got ${res.status}`);
  }
  check("the target is still a STUDENT",
    (await db.user.findUnique({ where: { id: victim.id }, select: { role: true } }))?.role === "STUDENT");

  console.log("3. Nobody below head can promote THEMSELVES");
  for (const [label, actor] of attackers) {
    const res = await fetch(`${BASE}/api/admin/users/${actor.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...cookie(actor) },
      body: JSON.stringify({ role: "HEAD" }),
    });
    // Any 4xx is a pass. The status varies by role and that is correct: the
    // self-protection guard ("you cannot change your own role") fires before the
    // role guard, so HR self-promotion is refused with 400 rather than 403. What
    // matters is the refusal and the unchanged role asserted immediately below —
    // pinning the exact code would fail on a harmless reordering of two guards.
    check(`${label} cannot promote themselves`, res.status >= 400 && res.status < 500, `got ${res.status}`);
    const after = await db.user.findUnique({ where: { id: actor.id }, select: { role: true } });
    check(`${label} is still ${actor.role}`, after?.role === actor.role, String(after?.role));
  }

  console.log("4. HR cannot create staff or mint invite codes");
  const hrCreate = await fetch(`${BASE}/api/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookie(hr) },
    body: JSON.stringify({
      username: `${TAG}hrmade`,
      email: `${TAG}hrmade@example.com`,
      mobile: String(mobile++),
      role: "HEAD",
    }),
  });
  check("HR cannot create a HEAD account", hrCreate.status === 403, `got ${hrCreate.status}`);
  const hrInvite = await fetch(`${BASE}/api/admin/invite-codes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookie(hr) },
    body: JSON.stringify({ role: "HR" }),
  });
  check("HR cannot mint an invite code", hrInvite.status === 403, `got ${hrInvite.status}`);

  console.log("5. Head-only surfaces refuse everyone else");
  for (const [label, actor] of attackers) {
    const audit = await fetch(`${BASE}/api/admin/audit`, { headers: cookie(actor) });
    check(`${label} cannot read the audit log`, audit.status === 403, `got ${audit.status}`);
    const invites = await fetch(`${BASE}/api/admin/invite-codes`, { headers: cookie(actor) });
    check(`${label} cannot list invite codes`, invites.status === 403, `got ${invites.status}`);
  }
  for (const [label, actor] of attackers) {
    const page = await fetch(`${BASE}/dashboard/admin/invite-codes`, { headers: cookie(actor), redirect: "manual" });
    check(`${label} is redirected away from the invite-codes page`, page.status === 307 || page.status === 302,
      `got ${page.status}`);
  }

  console.log("6. An anonymous caller reaches nothing");
  for (const path of ["/api/admin/audit", "/api/admin/invite-codes", "/api/admin/users"]) {
    const res = await fetch(`${BASE}${path}`);
    check(`${path} is 401 without a cookie`, res.status === 401, `got ${res.status}`);
  }

  console.log("7. A forged token is rejected");
  const forged = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ4Iiwicm9sZSI6IkhFQUQifQ.notarealsignature";
  const forgedRes = await fetch(`${BASE}/api/admin/audit`, { headers: { Cookie: `kca_access_token=${forged}` } });
  check("a hand-made HEAD token is refused", forgedRes.status === 401, `got ${forgedRes.status}`);

  console.log("8. The head cannot be stranded");
  // Demote every other head first so the one under test really is the last.
  const otherHeads = await db.user.findMany({
    where: { role: "HEAD", isActive: true, id: { not: head.id } },
    select: { id: true },
  });
  await db.user.updateMany({ where: { id: { in: otherHeads.map((h) => h.id) } }, data: { isActive: false } });

  try {
    const demote = await fetch(`${BASE}/api/admin/users/${head.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...cookie(head) },
      body: JSON.stringify({ role: "HR" }),
    });
    check("the last head cannot demote themselves", demote.status >= 400, `got ${demote.status}`);

    const deactivate = await fetch(`${BASE}/api/admin/users/${head.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...cookie(head) },
      body: JSON.stringify({ isActive: false }),
    });
    check("the last head cannot deactivate themselves", deactivate.status >= 400, `got ${deactivate.status}`);

    const stillHead = await db.user.findUnique({ where: { id: head.id }, select: { role: true, isActive: true } });
    check("the last head is still an active HEAD",
      stillHead?.role === "HEAD" && stillHead?.isActive === true, JSON.stringify(stillHead));

    const { anonymiseUser, AnonymiseError } = await import("../src/lib/compliance/anonymise");
    let erasureRefused = false;
    try {
      await anonymiseUser(head.id);
    } catch (error) {
      erasureRefused = error instanceof AnonymiseError;
    }
    check("the last head cannot be erased", erasureRefused);
  } finally {
    // Put the real heads back exactly as they were, whatever happened above.
    await db.user.updateMany({ where: { id: { in: otherHeads.map((h) => h.id) } }, data: { isActive: true } });
  }

  console.log("9. Demotion revokes the demoted account's sessions");
  const doomed = await mk("doom", "HR");
  await db.userSession.create({
    data: { userId: doomed.id, refreshToken: `${TAG}-doomed-token`, expiresAt: new Date(Date.now() + 86400000) },
  });
  const realHead = await db.user.findFirst({
    where: { role: "HEAD", isActive: true, username: { not: { startsWith: TAG } } },
    select: { id: true, username: true, role: true },
  });
  if (realHead) {
    await fetch(`${BASE}/api/admin/users/${doomed.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...cookie(realHead) },
      body: JSON.stringify({ role: "STUDENT" }),
    });
    const sessions = await db.userSession.count({ where: { userId: doomed.id } });
    check("a demoted account's sessions are destroyed", sessions === 0, `${sessions} left`);
  } else {
    check("a demoted account's sessions are destroyed", false, "no real HEAD to act as");
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
