/**
 * Promote an account to HEAD and set its password directly.
 *
 *   npx tsx --env-file=.env.local scripts/setHeadPassword.ts --username Rambo1998 --password '...'
 *
 * This is deliberately different from `createHeadUser.ts`, which creates an
 * account with an unusable hash and emails an activation code. That flow is right
 * for inviting someone; this one is for the academy owner setting their own
 * password on their own machine, where emailing themselves a code is a detour.
 *
 * It is a script rather than a UI for the obvious reason: nothing in the running
 * application should be able to hand out HEAD.
 *
 * The password is read from the command line, so it lands in your shell history.
 * Clear it afterwards (`history -d`) or set a different one from the app later.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "../src/lib/auth";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const username = arg("username");
  const password = arg("password");

  if (!username || !password) {
    console.error(
      "Usage: npx tsx --env-file=.env.local scripts/setHeadPassword.ts --username <name> --password '<password>'",
    );
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters — the same rule the app enforces.");
    process.exit(1);
  }

  const existing = await db.user.findFirst({
    where: { username: { equals: username, mode: "insensitive" } },
    select: { id: true, username: true, email: true, role: true, isActive: true },
  });

  if (!existing) {
    console.error(`No account named ${username}.`);
    console.error("To create one from scratch, use scripts/createHeadUser.ts instead.");
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);

  await db.user.update({
    where: { id: existing.id },
    data: {
      role: "HEAD",
      passwordHash,
      isActive: true,
      // A head who cannot be emailed a reset code is a locked-out academy.
      isVerified: true,
    },
  });

  // Any session minted while this account was a STUDENT still carries that role
  // in its JWT. Clearing them forces a fresh sign-in, so the new role is actually
  // in the token rather than taking effect only after it expires.
  const cleared = await db.userSession.deleteMany({ where: { userId: existing.id } });

  await db.auditLog.create({
    data: {
      userId: existing.id,
      action: "admin.user.update",
      metadata: {
        targetUserId: existing.id,
        from: { role: existing.role },
        to: { role: "HEAD" },
        via: "scripts/setHeadPassword.ts",
      },
    },
  });

  console.log(`${existing.username} <${existing.email}> is now HEAD.`);
  console.log(`Password set. ${cleared.count} existing session(s) cleared — sign in again.`);
  console.log("Sign in at /login (or /login/staff).");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
