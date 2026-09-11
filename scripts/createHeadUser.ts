/**
 * Create the first HEAD (academy owner) account.
 *
 *   npx tsx --env-file=.env.local scripts/createHeadUser.ts \
 *     --username owner --email you@example.com --mobile 9876543210
 *
 * Staff accounts are created by staff, so the very first one has nowhere to come
 * from — this is the only bootstrap. Everything afterwards is done in the app.
 *
 * No password is set here: the account is created unverified with an unusable
 * random hash and an activation code is emailed, exactly like an in-app invite.
 * That keeps one verified path to owning a password and means this script never
 * prints or transmits a credential.
 *
 * Safe to re-run: if a HEAD already exists it refuses unless --force is given.
 */
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "../src/lib/auth";
import { issueOtpCode } from "../src/lib/otp";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const username = arg("username");
  const email = arg("email")?.toLowerCase();
  const mobile = arg("mobile");
  const force = process.argv.includes("--force");

  if (!username || !email || !mobile) {
    console.error(
      "Usage: npx tsx --env-file=.env.local scripts/createHeadUser.ts --username <name> --email <email> --mobile <number> [--force]",
    );
    process.exit(1);
  }

  const existingHead = await db.user.count({ where: { role: "HEAD" } });
  if (existingHead > 0 && !force) {
    console.error(
      `A HEAD account already exists (${existingHead}). Create further staff from the app, or pass --force if you are certain.`,
    );
    process.exit(1);
  }

  const existing = await db.user.findFirst({
    where: { OR: [{ email }, { username }, { mobile }] },
    select: { id: true, email: true, role: true },
  });
  if (existing) {
    console.error(`An account already uses that email/username/mobile (role ${existing.role}).`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(crypto.randomBytes(32).toString("hex"));
  const user = await db.user.create({
    data: { username, email, mobile, role: "HEAD", passwordHash, isVerified: false, isActive: true },
    select: { id: true, username: true, email: true, role: true },
  });

  console.log(`Created ${user.role} account: ${user.username} <${user.email}>`);

  const issued = await issueOtpCode({
    email,
    purpose: "reset",
    intro: "Your Kamath Chess Academy head account has been created. Use this code to set your password.",
  }).catch((error) => {
    console.error("Invite email failed:", error);
    return { success: false as const };
  });

  if (issued.success) {
    console.log(`Activation code emailed to ${email}. Open /forgot-password and set your password (valid 10 minutes).`);
  } else {
    console.log(
      `Account created, but the email could not be sent. Check RESEND_API_KEY and EMAIL_FROM, then request a code at /forgot-password.`,
    );
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
