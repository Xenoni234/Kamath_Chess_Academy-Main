/**
 * DPDPA erasure: scrub a person out of the platform while keeping the records the
 * academy is required to retain.
 *
 * **This is an UPDATE, not a DELETE, and that is the whole design.** Three things
 * make a real `db.user.delete()` wrong here:
 *
 *  1. `GameReport.userId` has no `onDelete`, so Prisma defaults it to Restrict —
 *     the delete simply throws for any user who ever generated a report.
 *  2. `Payment` and `Invoice` cascade from User. Deleting the row would destroy
 *     fee records the privacy policy explicitly says are retained, and which tax
 *     law requires.
 *  3. `TournamentPlayer` cascades too, which would silently rewrite the standings
 *     of events other people played in.
 *
 * The consequence to keep in mind while reading this file: because nothing is
 * deleted at the top, **no cascade fires**, so every row that genuinely should go
 * has to be removed explicitly below. The schema's `onDelete` annotations are
 * irrelevant to this operation.
 *
 * Two rows are unreachable from the user relation and are swept by email instead:
 * `OtpVerification` rows whose `userId` is null (they carry a raw email and phone
 * number), and `ContactMessage`, which has no foreign key at all because
 * enquiries come from people who may never have had an account.
 *
 * `Game.pgn` is rewritten rather than deleted: the game belongs to the opponent
 * too, but the PGN tags embed the player's name.
 */
import crypto from "node:crypto";
import { db } from "@/lib/db";

export type AnonymiseResult = {
  userId: string;
  /** SHA-256 of the old email. Lets a later request be matched to this erasure
   *  without keeping the address itself — AuditLog.userId is SetNull, so without
   *  something like this the log cannot show whose data was erased. */
  emailSha256: string;
  removed: Record<string, number>;
  retained: Record<string, number>;
  gamesRewritten: number;
};

export class AnonymiseError extends Error {}

/** Placeholder that still satisfies the unique constraints on the identity columns. */
function placeholder(prefix: string, id: string): string {
  return `${prefix}_${id.slice(-12)}`;
}

/**
 * Strip a username out of a PGN's player tags, leaving the moves intact.
 * The game is also the opponent's record, so it is edited rather than removed.
 */
export function scrubPgn(pgn: string, username: string): string {
  if (!pgn || !username) return pgn;
  return pgn.replace(
    /(\[(?:White|Black)\s+")([^"]*)("\])/g,
    (match, open: string, name: string, close: string) =>
      name.toLowerCase() === username.toLowerCase() ? `${open}Deleted user${close}` : match,
  );
}

export async function anonymiseUser(userId: string): Promise<AnonymiseResult> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, email: true, mobile: true, role: true, isActive: true, anonymizedAt: true },
  });
  if (!user) throw new AnonymiseError("No such user.");
  if (user.anonymizedAt) throw new AnonymiseError("That account has already been anonymised.");

  // Same protection the admin role-change route enforces: the academy must not be
  // left without an owner, and erasure is a far worse way to discover that.
  if (user.role === "HEAD") {
    const otherHeads = await db.user.count({
      where: { role: "HEAD", isActive: true, anonymizedAt: null, id: { not: userId } },
    });
    if (otherHeads === 0) {
      throw new AnonymiseError("This is the only active head account — promote another before erasing it.");
    }
  }

  const oldEmail = user.email;
  const oldUsername = user.username;
  const emailSha256 = crypto.createHash("sha256").update(oldEmail.toLowerCase()).digest("hex");

  const removed: Record<string, number> = {};
  const retained: Record<string, number> = {};

  retained.payments = await db.payment.count({ where: { userId } });
  retained.invoices = await db.invoice.count({ where: { payment: { userId } } });
  retained.tournamentEntries = await db.tournamentPlayer.count({ where: { userId } });

  // --- rows that must go, each explicitly (no cascade fires on an UPDATE) ---
  removed.sessions = (await db.userSession.deleteMany({ where: { userId } })).count;
  removed.notifications = (await db.notification.deleteMany({ where: { userId } })).count;
  removed.studentProfiles = (await db.studentProfile.deleteMany({ where: { userId } })).count;
  removed.coachProfiles = (await db.coachProfile.deleteMany({ where: { userId } })).count;
  removed.savedOpenings = (await db.savedOpening.deleteMany({ where: { userId } })).count;
  removed.parentLinks = (
    await db.parentStudent.deleteMany({ where: { OR: [{ parentId: userId }, { studentId: userId }] } })
  ).count;

  // OTP rows: both the linked ones and the orphans that carry the raw address.
  // The orphans have no userId, so nothing else would ever reach them.
  removed.otpCodes = (
    await db.otpVerification.deleteMany({ where: { OR: [{ userId }, { email: oldEmail.toLowerCase() }] } })
  ).count;

  // Contact enquiries have no foreign key to User at all — matched by address.
  removed.contactMessages = (await db.contactMessage.deleteMany({ where: { email: oldEmail } })).count;

  // --- rewrite the games rather than destroy the opponent's record ---
  const games = await db.game.findMany({
    where: { OR: [{ whiteUserId: userId }, { blackUserId: userId }] },
    select: { id: true, pgn: true },
  });
  let gamesRewritten = 0;
  for (const game of games) {
    const scrubbed = scrubPgn(game.pgn, oldUsername);
    if (scrubbed !== game.pgn) {
      await db.game.update({ where: { id: game.id }, data: { pgn: scrubbed } });
      gamesRewritten++;
    }
  }

  // --- scrub the identity itself ---
  const now = new Date();
  await db.user.update({
    where: { id: userId },
    data: {
      username: placeholder("deleted", userId),
      email: `${placeholder("deleted", userId)}@deleted.invalid`,
      mobile: placeholder("deleted", userId),
      // An unusable hash, not a blank: a blank would be a password nobody set but
      // something might still compare against.
      passwordHash: crypto.randomBytes(32).toString("hex"),
      fideId: null,
      lichessId: null,
      chesscomId: null,
      avatarUrl: null,
      bio: null,
      isActive: false,
      isVerified: false,
      anonymizedAt: now,
    },
  });

  return { userId, emailSha256, removed, retained, gamesRewritten };
}
