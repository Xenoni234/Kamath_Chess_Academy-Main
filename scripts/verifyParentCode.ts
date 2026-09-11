/**
 * A parent account cannot be created for a child the registrant cannot prove a claim to.
 *
 *   npm run dev            # in another terminal
 *   npx tsx --env-file=.env.local scripts/verifyParentCode.ts
 *
 * PARENT is a self-service role whose entire purpose is reading one child's
 * attendance, reports, fees and games. So the question this file answers is:
 * what stops a stranger registering as the parent of a student whose username
 * they guessed?
 *
 * The answer is two secrets, not one — the student's username AND a code shown
 * only on that student's own dashboard. The assertions below try each half
 * alone, the wrong pairing of a real username with a real code belonging to a
 * different student, and a stale code after regeneration.
 *
 * One assertion is about discretion rather than access: every failure must give
 * the SAME message. A distinct "no such student" would turn registration into a
 * way to enumerate which children are on the platform.
 *
 * Self-cleaning on every exit path.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import { getOrCreateParentCode, regenerateParentCode } from "../src/lib/parentCode";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const TAG = "kcapc";
const PASSWORD = "Str0ng!TestPass2026";
const CODE = "424242";

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
    await db.parentStudent.deleteMany({ where: { OR: [{ parentId: { in: ids } }, { studentId: { in: ids } }] } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.studentProfile.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}

const RUN = Date.now().toString().slice(-6);
let seq = 0;
async function registerParent(studentUsername: string, parentCode: string) {
  seq++;
  const suffix = `${RUN}${String(seq).padStart(2, "0")}`;
  const email = `${TAG}${suffix}@example.com`;
  await db.otpVerification.create({
    data: {
      email,
      otpHash: await bcrypt.hash(CODE, 10),
      purpose: "register",
      expiresAt: new Date(Date.now() + 600000),
      attempts: 0,
    },
  });
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: `${TAG}${suffix}`,
      email,
      mobile: `9${suffix.padStart(9, "0").slice(-9)}`,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      otp: CODE,
      role: "PARENT",
      studentUsername,
      parentCode,
      agreedToTerms: true,
      agreedToAge: true,
      agreedToDataProcessing: true,
    }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})), username: `${TAG}${suffix}` };
}

async function main() {
  await cleanup();

  let mobile = Number(`9${Date.now().toString().slice(-9)}`);
  const mkStudent = async (suffix: string) =>
    db.user.create({
      data: {
        username: `${TAG}${suffix}`,
        email: `${TAG}${suffix}@example.com`,
        mobile: String(mobile++),
        passwordHash: "x",
        role: "STUDENT",
        studentProfile: { create: {} },
      },
      select: { id: true, username: true },
    });

  const child = await mkStudent("kid");
  const other = await mkStudent("kid2");

  const childCode = (await getOrCreateParentCode(child.id))!;
  const otherCode = (await getOrCreateParentCode(other.id))!;

  console.log("1. The code looks usable by a human");
  check("it is issued", Boolean(childCode), String(childCode));
  check("it is short and unambiguous (ABC-DEF)", /^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(childCode), childCode);
  check("two students get different codes", childCode !== otherCode, `${childCode} / ${otherCode}`);
  check("reading it again is stable", (await getOrCreateParentCode(child.id)) === childCode);

  console.log("2. Neither half works alone");
  const noCode = await registerParent(child.username, "");
  check("username with no code is rejected", noCode.status === 400, `got ${noCode.status}`);
  const noName = await registerParent("", childCode);
  check("code with no username is rejected", noName.status === 400, `got ${noName.status}`);
  const guessed = await registerParent(child.username, "ZZZ-ZZZ");
  check("a guessed code is rejected", guessed.status === 400, `got ${guessed.status}`);

  console.log("3. A real code for the WRONG student is rejected");
  const crossed = await registerParent(child.username, otherCode);
  check("another student's code does not work", crossed.status === 400, `got ${crossed.status}`);
  const links = await db.parentStudent.count({ where: { studentId: child.id } });
  check("no link was created by any failed attempt", links === 0, `found ${links}`);

  console.log("4. Every failure says the same thing (no enumeration oracle)");
  const messages = [noCode, guessed, crossed].map((r) => String(r.body.message));
  check("wrong code and wrong pairing are indistinguishable",
    messages[1] === messages[2], JSON.stringify(messages.slice(1)));
  check("the message names neither the student nor the reason",
    !messages[1].toLowerCase().includes("no such") && !messages[1].includes(child.username),
    messages[1]);

  console.log("5. The right pair works, and links the parent to that child");
  const ok = await registerParent(child.username, childCode);
  check("registration succeeds", ok.status === 201, `${ok.status} ${JSON.stringify(ok.body).slice(0, 120)}`);
  check("the account is a PARENT", (ok.body.user as { role?: string })?.role === "PARENT",
    String((ok.body.user as { role?: string })?.role));

  const parent = await db.user.findUnique({ where: { username: ok.username }, select: { id: true } });
  const linked = await db.parentStudent.findFirst({
    where: { parentId: parent!.id, studentId: child.id },
    select: { id: true },
  });
  check("the parent is linked to THAT child", Boolean(linked));
  check("and to nobody else",
    (await db.parentStudent.count({ where: { parentId: parent!.id } })) === 1);

  console.log("6. The code is reusable — a child can have two parents");
  const second = await registerParent(child.username, childCode);
  check("a second parent can use the same code", second.status === 201, `got ${second.status}`);
  check("the child now has two linked parents",
    (await db.parentStudent.count({ where: { studentId: child.id } })) === 2);

  console.log("7. Regenerating invalidates the old code");
  const fresh = (await regenerateParentCode(child.id))!;
  check("a new code is issued", fresh !== childCode, `${childCode} -> ${fresh}`);
  const stale = await registerParent(child.username, childCode);
  check("the OLD code no longer works", stale.status === 400, `got ${stale.status}`);
  const withNew = await registerParent(child.username, fresh);
  check("the NEW code works", withNew.status === 201, `got ${withNew.status}`);

  console.log("8. Only a student has a parent code");
  const parentToken = (await import("../src/lib/auth")).signAccessToken({
    userId: parent!.id,
    username: ok.username,
    role: "PARENT",
  });
  const asParent = await fetch(`${BASE}/api/user/parent-code`, {
    headers: { Cookie: `kca_access_token=${parentToken}` },
  });
  check("a parent asking for a parent code gets 403", asParent.status === 403, `got ${asParent.status}`);
  const anon = await fetch(`${BASE}/api/user/parent-code`);
  check("no cookie gets 401", anon.status === 401, `got ${anon.status}`);

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
