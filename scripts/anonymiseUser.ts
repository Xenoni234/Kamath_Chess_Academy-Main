/**
 * Honour a DPDPA erasure request.
 *
 *   npx tsx --env-file=.env.local scripts/anonymiseUser.ts --email someone@example.com
 *   npx tsx --env-file=.env.local scripts/anonymiseUser.ts --email someone@example.com --apply
 *
 * The privacy policy tells people to request erasure through the contact form.
 * This is how that request actually gets carried out. It is a script rather than a
 * button on purpose: erasure is irreversible, it is rare, and it should involve a
 * human who has checked that the request is genuine and comes from the account
 * holder (or a parent, for a minor).
 *
 * Dry run by default — it prints exactly what would be removed, kept and
 * rewritten. Nothing is written without --apply.
 *
 * What survives, and why: fee and invoice records are retained with the identity
 * stripped, because financial records have a statutory retention period and the
 * privacy policy says so in its Retention clause. Tournament results survive so
 * other players' standings are not rewritten. Games survive with the player's
 * name replaced in the PGN, because the game is the opponent's record too.
 */
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const email = arg("email")?.toLowerCase();
  const apply = process.argv.includes("--apply");

  if (!email) {
    console.error("Usage: npx tsx --env-file=.env.local scripts/anonymiseUser.ts --email <email> [--apply]");
    process.exit(1);
  }

  const user = await db.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, username: true, email: true, role: true, createdAt: true, anonymizedAt: true },
  });

  if (!user) {
    console.error(`No account found for ${email}.`);
    console.error("Check the contact form message — the request may name a different address.");
    process.exit(1);
  }

  if (user.anonymizedAt) {
    console.log(`${user.email} was already anonymised on ${user.anonymizedAt.toISOString()}. Nothing to do.`);
    return;
  }

  console.log(`Account:  ${user.username} <${user.email}>`);
  console.log(`Role:     ${user.role}`);
  console.log(`Created:  ${user.createdAt.toISOString()}`);
  console.log(`SHA-256:  ${crypto.createHash("sha256").update(user.email.toLowerCase()).digest("hex")}`);
  console.log();

  if (!apply) {
    // Count without touching anything.
    const [sessions, notifications, otps, contacts, games, payments, invoices, tournaments] = await Promise.all([
      db.userSession.count({ where: { userId: user.id } }),
      db.notification.count({ where: { userId: user.id } }),
      db.otpVerification.count({ where: { OR: [{ userId: user.id }, { email: user.email.toLowerCase() }] } }),
      db.contactMessage.count({ where: { email: user.email } }),
      db.game.count({ where: { OR: [{ whiteUserId: user.id }, { blackUserId: user.id }] } }),
      db.payment.count({ where: { userId: user.id } }),
      db.invoice.count({ where: { payment: { userId: user.id } } }),
      db.tournamentPlayer.count({ where: { userId: user.id } }),
    ]);
    console.log("WOULD REMOVE:");
    console.log(`  sessions ${sessions} · notifications ${notifications} · otp rows ${otps} · enquiries ${contacts}`);
    console.log("  profiles, saved openings, parent/child links");
    console.log("WOULD REWRITE:");
    console.log(`  ${games} game PGN(s), replacing the player's name`);
    console.log("WOULD RETAIN (identity stripped):");
    console.log(`  payments ${payments} · invoices ${invoices} · tournament entries ${tournaments}`);
    console.log("\nDry run — re-run with --apply to carry this out. It cannot be undone.");
    return;
  }

  const { anonymiseUser, AnonymiseError } = await import("../src/lib/compliance/anonymise");
  const { writeAuditLog } = await import("../src/lib/audit");

  try {
    const result = await anonymiseUser(user.id);
    // The audit row records the SHA, never the address: AuditLog.userId is
    // SetNull, so this hash is the only way to later prove which request this
    // erasure satisfied without retaining the very data we just erased.
    await writeAuditLog({
      action: "user.anonymise",
      userId: null,
      metadata: {
        subjectUserId: result.userId,
        emailSha256: result.emailSha256,
        removed: result.removed,
        retained: result.retained,
        gamesRewritten: result.gamesRewritten,
      },
    });
    console.log("REMOVED:  ", JSON.stringify(result.removed));
    console.log("RETAINED: ", JSON.stringify(result.retained));
    console.log("REWRITTEN:", result.gamesRewritten, "game PGN(s)");
    console.log("\n✅ Done. The account is anonymised and an audit record was written.");
    console.log("   Reply to the requester and mark their enquiry handled in the staff inbox.");
  } catch (error) {
    if (error instanceof AnonymiseError) {
      console.error(`Refused: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
