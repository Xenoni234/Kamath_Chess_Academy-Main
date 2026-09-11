/**
 * The class room does not leak to people outside the class.
 *
 *   npm run dev            # in another terminal
 *   npx tsx --env-file=.env.local scripts/verifyRoomSecurity.ts
 *
 * What this is defending against: the embedded video room used to be named
 * `KCA-<class cuid>`. Class ids appear in URLs, so anyone who saw or guessed one
 * could open `meet.jit.si/KCA-<that id>` and walk into a live class of children
 * with no KCA account at all. The student's display name was also placed in the
 * URL fragment, which puts a child's name into browser history and the DOM.
 *
 * So there are two kinds of assertion here, and both matter. The API assertions
 * prove the key is a secret handed only to participants and that it rotates. The
 * grep assertions prove the dangerous URL construction has not come back — a
 * future edit could reintroduce it while every API test still passed.
 *
 * Self-cleaning on every exit path.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { signAccessToken } from "../src/lib/auth";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const TAG = "kcaroomtest";

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
  await db.class.deleteMany({ where: { title: { startsWith: TAG } } });
  if (ids.length) {
    await db.coachProfile.deleteMany({ where: { userId: { in: ids } } });
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}

function tokenFor(u: { id: string; username: string; role: string }) {
  return signAccessToken({ userId: u.id, username: u.username, role: u.role as never });
}

async function getRoom(classId: string, token: string) {
  const res = await fetch(`${BASE}/api/classes/${classId}/room`, {
    headers: { Cookie: `kca_access_token=${token}` },
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
  const student = await mk("student", "STUDENT");
  const outsider = await mk("outsider", "STUDENT");

  const coachProfile = await db.coachProfile.create({ data: { userId: coach.id }, select: { id: true } });
  const cls = await db.class.create({
    data: {
      title: `${TAG} class`,
      coachId: coachProfile.id,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 3600_000),
    },
    select: { id: true },
  });
  await db.classEnrollment.create({ data: { classId: cls.id, userId: student.id } });

  console.log("1. The room key reaches participants only");
  const asCoach = await getRoom(cls.id, tokenFor(coach));
  check("coach gets the room", asCoach.status === 200, `got ${asCoach.status}`);
  const key = asCoach.body?.room?.videoRoomKey;
  check("coach receives a videoRoomKey", typeof key === "string" && key.length > 10, String(key));
  check("the key is NOT the class id", typeof key === "string" && key !== cls.id, `key=${key} id=${cls.id}`);

  const asStudent = await getRoom(cls.id, tokenFor(student));
  check("enrolled student gets the room", asStudent.status === 200, `got ${asStudent.status}`);
  check("enrolled student receives the same key",
    typeof key === "string" && asStudent.body?.room?.videoRoomKey === key);

  const asOutsider = await getRoom(cls.id, tokenFor(outsider));
  check("outsider gets 404 (not 403 — ids must not be probeable)", asOutsider.status === 404,
    `got ${asOutsider.status}`);
  check("outsider's response body contains no room key",
    typeof key === "string" && !JSON.stringify(asOutsider.body).includes(key),
    JSON.stringify(asOutsider.body).slice(0, 120));

  console.log("2. Starting the class rotates the key");
  const start = async () =>
    fetch(`${BASE}/api/classes/${cls.id}/room`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `kca_access_token=${tokenFor(coach)}` },
      body: JSON.stringify({ action: "start" }),
    });
  await start();
  const afterFirst = (await getRoom(cls.id, tokenFor(coach))).body?.room?.videoRoomKey;
  await start();
  const afterSecond = (await getRoom(cls.id, tokenFor(coach))).body?.room?.videoRoomKey;
  check("key changed after the first start",
    typeof afterFirst === "string" && afterFirst !== key, `${key} -> ${afterFirst}`);
  check("key changed again after the second start",
    typeof afterSecond === "string" && afterSecond !== afterFirst, `${afterFirst} -> ${afterSecond}`);

  console.log("3. The dangerous URL construction has not come back");
  const page = readFileSync("src/app/(dashboard)/dashboard/classes/[id]/room/page.tsx", "utf8");
  // Strip block comments: the file documents the old pattern on purpose.
  const code = page.replace(/\/\*[\s\S]*?\*\//g, "");
  check("no room URL built from the class id", !code.includes("KCA-${room.id}"));
  check("no display name in a URL fragment", !code.includes("userInfo.displayName="));
  check("display name is passed via the options object", code.includes("userInfo: { displayName }"));

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
