/**
 * Erasure removes the person, keeps the records the academy must keep, and
 * cannot be talked into leaving the academy without an owner.
 *
 *   npx tsx --env-file=.env.local scripts/verifyAnonymise.ts
 *
 * Builds a user with a row in every relation that matters, erases them, then
 * checks each one individually. The reason for the breadth: erasure is an UPDATE,
 * so none of the schema's cascades fire and every deletion has to be written out
 * by hand. A missed relation is silent — the account looks erased while the data
 * is still there — and only an exhaustive test catches it.
 *
 * Two assertions are the ones that would actually embarrass us in an audit:
 * the orphan OTP row (no userId, carries a raw email and phone number, reachable
 * by no cascade at all), and the game PGN, which embeds the player's name in a
 * text column that survives on purpose because the game is the opponent's record.
 *
 * No dev server needed. Self-cleaning on every exit path.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { anonymiseUser, AnonymiseError, scrubPgn } from "../src/lib/compliance/anonymise";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const TAG = "kcaanontest";
const EMAIL = `${TAG}@example.com`;

/**
 * Ids created by this run.
 *
 * Cleanup cannot find these users by name, email or bio once the test has run —
 * anonymisation is precisely the operation that scrubs all three. An earlier
 * version matched on `bio: TAG`, which anonymiseUser sets to null, so the test
 * left its subjects behind in the database every time it passed.
 */
const created = new Set<string>();

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
  const byName = await db.user.findMany({
    where: { username: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = [...new Set([...byName.map((u) => u.id), ...created])];
  await db.contactMessage.deleteMany({ where: { email: { contains: TAG } } });
  await db.otpVerification.deleteMany({ where: { email: { contains: TAG } } });
  await db.game.deleteMany({ where: { pgn: { contains: TAG } } });
  if (ids.length) {
    const payments = await db.payment.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    await db.invoice.deleteMany({ where: { paymentId: { in: payments.map((p) => p.id) } } });
    await db.payment.deleteMany({ where: { userId: { in: ids } } });
    await db.userSession.deleteMany({ where: { userId: { in: ids } } });
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.studentProfile.deleteMany({ where: { userId: { in: ids } } });
    await db.savedOpening.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
  await db.auditLog.deleteMany({ where: { action: "user.anonymise", metadata: { path: ["tag"], equals: TAG } } });
}

async function main() {
  await cleanup();

  console.log("0. The PGN scrubber, in isolation");
  const pgn = `[White "alice"]\n[Black "bob"]\n\n1. e4 e5 2. Nf3 *`;
  const scrubbed = scrubPgn(pgn, "alice");
  check("the named player is replaced", scrubbed.includes('[White "Deleted user"]'), scrubbed.split("\n")[0]);
  check("the opponent is untouched", scrubbed.includes('[Black "bob"]'), scrubbed.split("\n")[1]);
  check("the moves survive", scrubbed.includes("1. e4 e5 2. Nf3"), scrubbed);
  check("matching is case-insensitive", scrubPgn(pgn, "ALICE").includes('[White "Deleted user"]'));

  console.log("1. Build a user with a row in every relation that matters");
  const suffix = Date.now().toString().slice(-9);
  const user = await db.user.create({
    data: {
      username: TAG,
      email: EMAIL,
      mobile: `9${suffix}`,
      passwordHash: "originalhash",
      role: "STUDENT",
      fideId: `F${suffix}`,
      lichessId: `${TAG}lichess`,
      chesscomId: `${TAG}chesscom`,
      avatarUrl: "https://example.com/avatar.png",
      bio: TAG,
      studentProfile: { create: {} },
      sessions: { create: { refreshToken: `${TAG}-token`, expiresAt: new Date(Date.now() + 86400000) } },
      notifications: { create: { type: "SYSTEM", title: "hello", body: "hi" } },
    },
    select: { id: true },
  });
  created.add(user.id);

  // An OTP row LINKED to the user, and an ORPHAN one carrying the raw address.
  await db.otpVerification.create({
    data: { userId: user.id, email: EMAIL, otpHash: "x", purpose: "login", expiresAt: new Date(Date.now() + 600000) },
  });
  await db.otpVerification.create({
    data: { email: EMAIL, otpHash: "x", purpose: "register", expiresAt: new Date(Date.now() + 600000) },
  });
  await db.contactMessage.create({
    data: { name: "Test", email: EMAIL, message: `${TAG} please delete my account` },
  });
  const payment = await db.payment.create({
    data: { userId: user.id, amount: 2500, status: "COMPLETED", description: "Term fees", paidAt: new Date() },
    select: { id: true },
  });
  await db.invoice.create({ data: { paymentId: payment.id, number: `KCA-TEST-${suffix}` } });
  const game = await db.game.create({
    data: {
      whiteUserId: user.id,
      pgn: `[Event "${TAG} game"]\n[White "${TAG}"]\n[Black "opponent"]\n\n1. d4 d5 *`,
      timeFormat: "BLITZ",
      result: "WHITE_WIN",
    },
    select: { id: true },
  });

  console.log("2. Erase");
  const result = await anonymiseUser(user.id);
  check("an email hash was returned instead of the address",
    /^[0-9a-f]{64}$/.test(result.emailSha256) && !JSON.stringify(result).includes(EMAIL),
    result.emailSha256.slice(0, 16));

  const after = await db.user.findUnique({
    where: { id: user.id },
    select: {
      username: true, email: true, mobile: true, passwordHash: true, fideId: true,
      lichessId: true, chesscomId: true, avatarUrl: true, bio: true,
      isActive: true, isVerified: true, anonymizedAt: true,
    },
  });
  check("the user row still exists (erasure is an UPDATE)", Boolean(after));
  check("username is scrubbed", after?.username.startsWith("deleted_") === true, String(after?.username));
  check("email is scrubbed to an unroutable address", after?.email.endsWith("@deleted.invalid") === true,
    String(after?.email));
  check("mobile is scrubbed", after?.mobile.startsWith("deleted_") === true, String(after?.mobile));
  check("password hash is replaced, not blanked",
    after?.passwordHash !== "originalhash" && (after?.passwordHash?.length ?? 0) > 20);
  check("chess identities are cleared",
    after?.fideId === null && after?.lichessId === null && after?.chesscomId === null);
  check("avatar and bio are cleared", after?.avatarUrl === null && after?.bio === null);
  check("account is deactivated", after?.isActive === false && after?.isVerified === false);
  check("anonymizedAt is stamped", Boolean(after?.anonymizedAt));

  console.log("3. Everything that should be gone, is");
  check("sessions removed", (await db.userSession.count({ where: { userId: user.id } })) === 0);
  check("notifications removed", (await db.notification.count({ where: { userId: user.id } })) === 0);
  check("student profile removed", (await db.studentProfile.count({ where: { userId: user.id } })) === 0);
  const otpLeft = await db.otpVerification.count({ where: { email: EMAIL } });
  check("OTP rows removed INCLUDING the orphan with no userId", otpLeft === 0, `${otpLeft} left`);
  const contactLeft = await db.contactMessage.count({ where: { email: EMAIL } });
  check("contact enquiries removed (matched by email — there is no FK)", contactLeft === 0, `${contactLeft} left`);

  console.log("4. Everything that must be kept, is");
  const paymentAfter = await db.payment.findUnique({
    where: { id: payment.id },
    select: { amount: true, userId: true },
  });
  check("the payment survives with its amount", Number(paymentAfter?.amount) === 2500, String(paymentAfter?.amount));
  check("the payment still points at the (now anonymous) user", paymentAfter?.userId === user.id);
  check("the invoice survives", (await db.invoice.count({ where: { paymentId: payment.id } })) === 1);

  const gameAfter = await db.game.findUnique({ where: { id: game.id }, select: { pgn: true } });
  check("the game survives", Boolean(gameAfter));
  check("the PGN no longer contains the old username",
    gameAfter?.pgn.includes(`[White "${TAG}"]`) === false, String(gameAfter?.pgn).split("\n")[1]);
  check("the PGN moves survive", gameAfter?.pgn.includes("1. d4 d5") === true);
  check("the opponent's tag is untouched", gameAfter?.pgn.includes('[Black "opponent"]') === true);

  console.log("5. Refusals");
  let refused = false;
  try {
    await anonymiseUser(user.id);
  } catch (error) {
    refused = error instanceof AnonymiseError;
  }
  check("erasing an already-erased account is refused", refused);

  const heads = await db.user.count({ where: { role: "HEAD", isActive: true, anonymizedAt: null } });
  if (heads === 0) {
    const soleHead = await db.user.create({
      data: {
        username: `${TAG}head`,
        email: `${TAG}head@example.com`,
        mobile: `8${suffix}`,
        passwordHash: "x",
        role: "HEAD",
        bio: TAG,
      },
      select: { id: true },
    });
    created.add(soleHead.id);
    let headRefused = false;
    try {
      await anonymiseUser(soleHead.id);
    } catch (error) {
      headRefused = error instanceof AnonymiseError;
    }
    check("erasing the only active HEAD is refused", headRefused);
    await db.user.delete({ where: { id: soleHead.id } });
  } else {
    console.log(`  SKIP  sole-HEAD guard (a real HEAD exists; refusing to touch it)`);
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
