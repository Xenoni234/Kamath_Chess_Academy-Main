/**
 * The contact form is rate limited, and staff can actually read it.
 *
 *   npm run dev            # in another terminal
 *   npx tsx --env-file=.env.local scripts/verifyContact.ts
 *
 * This form is the channel the privacy policy names for exercising DPDPA rights,
 * and until now nothing in the app read the table it writes to. The assertions
 * below are therefore about the promise being keepable: a request gets stored, a
 * staff member can see it, and they can mark it done.
 *
 * The fail-open assertion matters as much as the rate limit itself. This is the
 * academy's only inbound lead channel, so a Redis outage must not silently
 * swallow enquiries — the limiter is allowed to stop working, not to start
 * rejecting.
 *
 * Self-cleaning on every exit path.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { signAccessToken } from "../src/lib/auth";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const TAG = "kcacontacttest";
const EMAIL = `${TAG}@example.com`;

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
  await db.contactMessage.deleteMany({ where: { email: EMAIL } });
  const users = await db.user.findMany({ where: { username: { startsWith: TAG } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}

function tokenFor(u: { id: string; username: string; role: string }) {
  return signAccessToken({ userId: u.id, username: u.username, role: u.role as never });
}

async function submit(ip: string, message: string) {
  const res = await fetch(`${BASE}/api/contact`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ name: "Test Parent", email: EMAIL, mobile: "9876500000", message }),
  });
  return res.status;
}

async function main() {
  await cleanup();

  // A unique IP per run so a previous run's counter can't poison this one.
  const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;

  console.log("1. Enquiries are stored and rate limited per IP");
  const statuses: number[] = [];
  for (let i = 1; i <= 6; i++) {
    statuses.push(await submit(ip, `${TAG} enquiry number ${i} about coaching`));
  }
  check("the first five are accepted", statuses.slice(0, 5).every((s) => s === 200),
    statuses.join(","));
  check("the sixth is rejected with 429", statuses[5] === 429, `got ${statuses[5]}`);

  const stored = await db.contactMessage.count({ where: { email: EMAIL } });
  check("exactly five rows were written (the blocked one stored nothing)", stored === 5, `got ${stored}`);

  console.log("2. A different IP is not affected by that limit");
  const otherIp = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  const otherStatus = await submit(otherIp, `${TAG} enquiry from a different household`);
  check("a different IP is still accepted", otherStatus === 200, `got ${otherStatus}`);

  console.log("3. Only staff can read the inbox");
  let mobile = Number(`9${Date.now().toString().slice(-9)}`);
  const mk = async (suffix: string, role: "STUDENT" | "HR") =>
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
  const student = await mk("student", "STUDENT");
  const hr = await mk("hr", "HR");

  const asStudent = await fetch(`${BASE}/api/admin/contact`, {
    headers: { Cookie: `kca_access_token=${tokenFor(student)}` },
  });
  check("a student gets 403", asStudent.status === 403, `got ${asStudent.status}`);

  const noAuth = await fetch(`${BASE}/api/admin/contact`);
  check("no cookie gets 401", noAuth.status === 401, `got ${noAuth.status}`);

  const asHr = await fetch(`${BASE}/api/admin/contact?handled=false`, {
    headers: { Cookie: `kca_access_token=${tokenFor(hr)}` },
  });
  const hrBody = await asHr.json().catch(() => ({}));
  check("HR gets the list", asHr.status === 200, `got ${asHr.status}`);
  const mine = (hrBody.messages ?? []).filter((m: { email: string }) => m.email === EMAIL);
  check("the test enquiries appear in the open queue", mine.length >= 5, `got ${mine.length}`);

  console.log("4. Marking handled works and is audited");
  const target = mine[0];
  const patch = await fetch(`${BASE}/api/admin/contact/${target.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: `kca_access_token=${tokenFor(hr)}` },
    body: JSON.stringify({ handled: true }),
  });
  check("PATCH succeeds", patch.status === 200, `got ${patch.status}`);
  const row = await db.contactMessage.findUnique({ where: { id: target.id }, select: { handled: true } });
  check("the row is now handled", row?.handled === true, String(row?.handled));

  const audit = await db.auditLog.count({ where: { userId: hr.id, action: "contact.handle" } });
  check("a contact.handle audit row was written", audit === 1, `got ${audit}`);
  const listAudit = await db.auditLog.count({ where: { userId: hr.id, action: "contact.list" } });
  check("staff reads of the inbox are audited", listAudit >= 1, `got ${listAudit}`);

  console.log("5. Filtering");
  const openAfter = await fetch(`${BASE}/api/admin/contact?handled=false`, {
    headers: { Cookie: `kca_access_token=${tokenFor(hr)}` },
  });
  const openBody = await openAfter.json().catch(() => ({}));
  const stillOpen = (openBody.messages ?? []).filter((m: { id: string }) => m.id === target.id);
  check("the handled enquiry left the open queue", stillOpen.length === 0, `got ${stillOpen.length}`);

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
