/**
 * The sign-up role dropdown does what the server says it does.
 *
 *   npm run dev            # in another terminal
 *   npx tsx --env-file=.env.local scripts/verifySignupRole.ts
 *
 * This file owns the `role` FIELD: which values the server accepts, what it does
 * with junk, and what it defaults to. The invite-code mechanics — minting, single
 * use, the concurrent-redemption race, expiry, revocation — belong to
 * scripts/verifyInviteCodes.ts, and are not duplicated here.
 *
 * Two things are asserted unconditionally, because they hold whatever the
 * academy's sign-up policy is:
 *
 *  - **HEAD can never be self-assigned.** It owns the academy's revenue, every
 *    student's record, the audit log, and the power to demote other staff. It is
 *    not in the dropdown and a hand-written request naming it must be refused.
 *  - **Junk is refused.** The payload is only JSON; anything outside the list is
 *    rejected rather than silently defaulted.
 *
 * Self-cleaning on every exit path.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import { SIGNUP_ROLE_OPTIONS, SELF_SIGNUP_ROLES, CODE_REQUIRED_ROLES } from "../src/lib/validations";
import { getOrCreateParentCode } from "../src/lib/parentCode";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const TAG = "kcaroletest";
const PASSWORD = "Str0ng!TestPass2026";

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
  await db.otpVerification.deleteMany({ where: { email: { contains: TAG } } });
  const users = await db.user.findMany({ where: { username: { startsWith: TAG } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.studentProfile.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}

/**
 * Seed a redeemable code directly.
 *
 * Deliberately NOT through /api/auth/otp/send. That endpoint is rate limited to
 * ten requests per IP per hour, and this test registers nine accounts — so going
 * through it made the test throttle itself and report the role allowlist as
 * broken when it was fine. Whether codes are issued correctly is
 * verifyRegistration's job; this file only cares what happens to `role`.
 */
const CODE = "424242";
async function codeFor(email: string): Promise<string> {
  await db.otpVerification.create({
    data: {
      email: email.toLowerCase(),
      otpHash: await bcrypt.hash(CODE, 10),
      purpose: "register",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      attempts: 0,
    },
  });
  return CODE;
}

let seq = 0;
async function register(
  role: unknown,
  parentClaim?: { studentUsername: string; parentCode: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  seq++;
  const suffix = `${seq}${Date.now().toString().slice(-6)}`;
  const email = `${TAG}${suffix}@example.com`;
  const code = await codeFor(email);

  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: `${TAG}${suffix}`,
      email,
      mobile: `9${suffix.padEnd(9, "0").slice(0, 9)}`,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      otp: code,
      agreedToTerms: true,
      agreedToAge: true,
      agreedToDataProcessing: true,
      ...(role === undefined ? {} : { role }),
      ...(parentClaim ?? {}),
    }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  await cleanup();

  const free = SIGNUP_ROLE_OPTIONS.filter((r) => (SELF_SIGNUP_ROLES as readonly string[]).includes(r));
  const gated = SIGNUP_ROLE_OPTIONS.filter((r) => (CODE_REQUIRED_ROLES as readonly string[]).includes(r));
  console.log(`Policy: no code needed = [${free.join(", ")}] · code required = [${gated.join(", ") || "none"}]\n`);

  // PARENT is in SELF_SIGNUP_ROLES — it needs no INVITE code — but it does need a
  // parent claim: the student's username and that student's parent code. Seed a
  // student so the claim can be made. verifyParentCode owns the claim's rules;
  // this file only needs a valid one so the role assertion is about the role.
  let mobileSeed = Number(`8${Date.now().toString().slice(-9)}`);
  const child = await db.user.create({
    data: {
      username: `${TAG}kid`,
      email: `${TAG}kid@example.com`,
      mobile: String(mobileSeed++),
      passwordHash: "x",
      role: "STUDENT",
      studentProfile: { create: {} },
    },
    select: { id: true, username: true },
  });
  const childCode = (await getOrCreateParentCode(child.id))!;
  const claimFor = (r: string) =>
    r === "PARENT" ? { studentUsername: child.username, parentCode: childCode } : undefined;

  console.log("1. Roles that need no invite code are granted straight away");
  for (const role of free) {
    const attempt = await register(role, claimFor(role));
    check(`${role} is accepted`, attempt.status === 201, `got ${attempt.status} ${JSON.stringify(attempt.body).slice(0, 110)}`);
    check(`${role} really is a ${role}`,
      (attempt.body.user as { role?: string })?.role === role,
      String((attempt.body.user as { role?: string })?.role));
  }

  console.log("1b. A parent still cannot register without the student's code");
  const noClaim = await register("PARENT");
  check("PARENT with no parent code is refused", noClaim.status === 400, `got ${noClaim.status}`);

  console.log("2. Roles that need a code are refused without one");
  for (const role of gated) {
    const attempt = await register(role);
    check(`${role} is refused with no code`, attempt.status === 400, `got ${attempt.status}`);
    check(`${role} is refused FOR WANTING A CODE`,
      String(attempt.body.message ?? "").toLowerCase().includes("invite code"),
      JSON.stringify(attempt.body.message));
  }
  const gatecrashers = await db.user.count({
    where: { username: { startsWith: TAG }, role: { in: ["COACH", "HR"] } },
  });
  check("NO coach or staff account exists from those attempts", gatecrashers === 0, `found ${gatecrashers}`);

  console.log("2b. HEAD is never self-assignable, whatever the policy is");
  const asHead = await register("HEAD");
  check("HEAD is rejected with 400", asHead.status === 400, `got ${asHead.status}`);
  const heads = await db.user.count({ where: { username: { startsWith: TAG }, role: "HEAD" } });
  check("NO head account was created", heads === 0, `found ${heads}`);
  check("HEAD is not even offered in the dropdown",
    !(SIGNUP_ROLE_OPTIONS as readonly string[]).includes("HEAD"), SIGNUP_ROLE_OPTIONS.join(","));

  console.log("3. Junk and omission");
  const nonsense = await register("SUPERUSER");
  check("an unknown role is rejected", nonsense.status === 400, `got ${nonsense.status}`);
  const injected = await register({ toString: "HEAD" });
  check("a non-string role is rejected", injected.status === 400, `got ${injected.status}`);

  const omitted = await register(undefined);
  check("omitting the role still works (defaults to STUDENT)", omitted.status === 201, `got ${omitted.status}`);
  check("the default really is STUDENT",
    (omitted.body.user as { role?: string })?.role === "STUDENT",
    String((omitted.body.user as { role?: string })?.role));

  console.log("4. Profile rows match the role");
  const student = await db.user.findFirst({
    where: { username: { startsWith: TAG }, role: "STUDENT" },
    select: { id: true, studentProfile: { select: { id: true } } },
  });
  check("a student gets a student profile", Boolean(student?.studentProfile));
  const parent = await db.user.findFirst({
    where: { username: { startsWith: TAG }, role: "PARENT" },
    select: { id: true, studentProfile: { select: { id: true } } },
  });
  check("a parent account was created", Boolean(parent));
  check("a parent does NOT get a student profile", parent != null && parent.studentProfile === null,
    JSON.stringify(parent?.studentProfile));

  console.log("5. A parent is linked to exactly the child they proved a claim to");
  // This assertion used to read the opposite way: a fresh parent had NO links and
  // a blank dashboard until staff linked them by hand. The parent code replaced
  // that — proving the claim at registration is what creates the link, so staff
  // are no longer a required step between a parent and their own child.
  if (parent) {
    const links = await db.parentStudent.findMany({
      where: { parentId: parent.id },
      select: { studentId: true },
    });
    check("the parent is linked to exactly one child", links.length === 1, `got ${links.length}`);
    check("and it is the child whose code they used", links[0]?.studentId === child.id,
      `${links[0]?.studentId} vs ${child.id}`);
  } else {
    check("the parent is linked to exactly one child", false, "no parent account to check");
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
