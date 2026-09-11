/**
 * Coaches can reach and annotate their students' games; strangers cannot.
 *
 *   npm run dev            # in another terminal
 *   npx tsx --env-file=.env.local scripts/verifyAnnotation.ts
 *
 * The reason this feature needed a route change at all: `GET /api/games/[gameId]`
 * was participants-only, and a coach is neither the white nor the black player of
 * their student's game — so the board 404'd before it could render anything to
 * annotate. Access now runs through `canViewStudent`, which is the same rule every
 * other student-scoped route uses.
 *
 * That widening is exactly the kind of change that can go too far, so the negative
 * assertions carry as much weight as the positive ones: an unrelated coach and an
 * unrelated student must both still get 404, and a third-party read must land in
 * the audit log.
 *
 * Self-cleaning on every exit path.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { signAccessToken } from "../src/lib/auth";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const TAG = "kcaannottest";

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
  const games = await db.game.findMany({ where: { pgn: { contains: TAG } }, select: { id: true } });
  await db.gameAnnotation.deleteMany({ where: { gameId: { in: games.map((g) => g.id) } } });
  await db.game.deleteMany({ where: { pgn: { contains: TAG } } });
  await db.classEnrollment.deleteMany({ where: { userId: { in: ids } } });
  await db.class.deleteMany({ where: { title: { startsWith: TAG } } });
  await db.batch.deleteMany({ where: { name: { startsWith: TAG } } });
  if (ids.length) {
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.coachProfile.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}

function tokenFor(u: { id: string; username: string; role: string }) {
  return signAccessToken({ userId: u.id, username: u.username, role: u.role as never });
}

const cookie = (u: { id: string; username: string; role: string }) => ({
  Cookie: `kca_access_token=${tokenFor(u)}`,
});

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
  const otherCoach = await mk("othercoach", "COACH");
  const student = await mk("student", "STUDENT");
  const opponent = await mk("opponent", "STUDENT");
  const stranger = await mk("stranger", "STUDENT");

  const coachProfile = await db.coachProfile.create({ data: { userId: coach.id }, select: { id: true } });
  const batch = await db.batch.create({ data: { name: `${TAG} batch`, coachId: coachProfile.id }, select: { id: true } });
  await db.classEnrollment.create({ data: { batchId: batch.id, userId: student.id } });

  const game = await db.game.create({
    data: {
      whiteUserId: student.id,
      blackUserId: opponent.id,
      pgn: `[Event "${TAG}"]\n\n1. e4 e5 2. Nf3 Nc6 *`,
      moves: ["e2e4", "e7e5", "g1f3", "b8c6"],
      timeFormat: "BLITZ",
      result: "WHITE_WIN",
    },
    select: { id: true },
  });

  console.log("1. Reaching the game at all");
  const asStudent = await fetch(`${BASE}/api/games/${game.id}`, { headers: cookie(student) });
  check("the student who played it gets 200", asStudent.status === 200, `got ${asStudent.status}`);

  const asCoach = await fetch(`${BASE}/api/games/${game.id}`, { headers: cookie(coach) });
  check("their coach now gets 200 (this used to 404)", asCoach.status === 200, `got ${asCoach.status}`);
  const coachBody = await asCoach.json().catch(() => ({}));
  check("the response marks the coach as not a player", coachBody.isPlayer === false, String(coachBody.isPlayer));

  const asOtherCoach = await fetch(`${BASE}/api/games/${game.id}`, { headers: cookie(otherCoach) });
  check("an unrelated coach still gets 404", asOtherCoach.status === 404, `got ${asOtherCoach.status}`);

  const asStranger = await fetch(`${BASE}/api/games/${game.id}`, { headers: cookie(stranger) });
  check("an unrelated student still gets 404", asStranger.status === 404, `got ${asStranger.status}`);

  const audited = await db.auditLog.count({ where: { userId: coach.id, action: "game.view" } });
  check("the coach's third-party read was audited", audited >= 1, `got ${audited}`);
  const selfAudited = await db.auditLog.count({ where: { userId: student.id, action: "game.view" } });
  check("the player's own read was NOT audited", selfAudited === 0, `got ${selfAudited}`);

  console.log("2. Writing notes");
  const put = async (u: typeof coach, ply: number, body: string) =>
    fetch(`${BASE}/api/games/${game.id}/annotations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...cookie(u) },
      body: JSON.stringify({ ply, body }),
    });

  const saved = await put(coach, 3, "Nf3 develops and eyes e5 — compare this with Bc4 first.");
  check("the coach can save a note", saved.status === 200, `got ${saved.status}`);

  const studentWrite = await put(student, 3, "my own note");
  check("the student cannot annotate (403, not 404 — they can see the game)",
    studentWrite.status === 403, `got ${studentWrite.status}`);

  const strangerWrite = await put(stranger, 3, "nope");
  check("a stranger gets 404 on write", strangerWrite.status === 404, `got ${strangerWrite.status}`);

  console.log("3. Upsert semantics");
  await put(coach, 3, "Revised: Nf3 is the main line.");
  const rows = await db.gameAnnotation.count({ where: { gameId: game.id, coachId: coach.id, ply: 3 } });
  check("re-saving the same ply UPDATES rather than duplicating", rows === 1, `got ${rows} rows`);
  const body = await db.gameAnnotation.findFirst({
    where: { gameId: game.id, coachId: coach.id, ply: 3 },
    select: { body: true },
  });
  check("the text was replaced", body?.body.startsWith("Revised:") === true, String(body?.body));

  console.log("4. Reading notes back");
  const list = await fetch(`${BASE}/api/games/${game.id}/annotations`, { headers: cookie(student) });
  const listBody = await list.json().catch(() => ({}));
  check("the student can read their coach's notes", list.status === 200, `got ${list.status}`);
  check("the note is there", (listBody.annotations ?? []).length === 1, JSON.stringify(listBody).slice(0, 120));
  check("the student is told they cannot annotate", listBody.canAnnotate === false, String(listBody.canAnnotate));
  check("the note is not marked as theirs",
    (listBody.annotations ?? [])[0]?.mine === false, String((listBody.annotations ?? [])[0]?.mine));
  check("the coach's name is attached",
    (listBody.annotations ?? [])[0]?.coachName === coach.username,
    String((listBody.annotations ?? [])[0]?.coachName));

  const strangerList = await fetch(`${BASE}/api/games/${game.id}/annotations`, { headers: cookie(stranger) });
  check("a stranger gets 404 on read", strangerList.status === 404, `got ${strangerList.status}`);

  console.log("5. Clearing a note");
  const cleared = await put(coach, 3, "   ");
  check("saving whitespace removes the note", cleared.status === 200, `got ${cleared.status}`);
  const left = await db.gameAnnotation.count({ where: { gameId: game.id, ply: 3 } });
  check("the row is gone", left === 0, `got ${left}`);

  console.log("6. Validation");
  const badPly = await put(coach, -1, "note");
  check("a negative ply is a 400", badPly.status === 400, `got ${badPly.status}`);

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
