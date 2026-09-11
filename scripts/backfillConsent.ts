/**
 * Backfill consent records for accounts created before consent was stored.
 *
 *   npx tsx --env-file=.env.local scripts/backfillConsent.ts [--apply]
 *
 * Registration used to validate the three mandatory consents and then discard
 * them, keeping only the two optional ones inside an `AuditLog.metadata` blob. So
 * existing accounts have no consent columns at all.
 *
 * What can honestly be recovered, and what cannot:
 *
 *  - Marketing and SMS: recoverable. The `USER_REGISTERED` audit row records
 *    exactly what was ticked, so those become real values.
 *  - The three mandatory consents: NOT recoverable as timestamps. We know they
 *    were given — registration refuses without them — but not the instant. The
 *    account's `createdAt` is used as a proxy and the row is stamped
 *    `consentVersion: "legacy-audit"` so nobody later mistakes a proxy for a
 *    recorded time.
 *
 * Accounts with no `USER_REGISTERED` audit row at all (created by staff, or by
 * the bootstrap script) are left untouched: inventing consent for them would be
 * worse than leaving the field null, which correctly reads as "unknown".
 *
 * Idempotent — only touches rows where `consentVersion` is null. Dry run by
 * default; pass --apply to write.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const APPLY = process.argv.includes("--apply");

async function main() {
  const users = await db.user.findMany({
    where: { consentVersion: null },
    select: { id: true, username: true, createdAt: true },
  });

  if (users.length === 0) {
    console.log("Nothing to do — every account already has a consent record.");
    return;
  }

  console.log(`${users.length} account(s) without a consent record.${APPLY ? "" : "  (dry run)"}\n`);

  let filled = 0;
  let skipped = 0;

  for (const user of users) {
    const audit = await db.auditLog.findFirst({
      where: { userId: user.id, action: "USER_REGISTERED" },
      orderBy: { createdAt: "asc" },
      select: { metadata: true, createdAt: true },
    });

    if (!audit) {
      skipped++;
      console.log(`  skip  ${user.username} — no USER_REGISTERED row; consent stays unknown`);
      continue;
    }

    const meta = (audit.metadata ?? {}) as Record<string, unknown>;
    const marketing = meta.marketingEmailConsent === true;
    const sms = meta.smsNotificationConsent === true;
    // The audit row's own timestamp is closer to the truth than createdAt.
    const at = audit.createdAt ?? user.createdAt;

    if (APPLY) {
      await db.user.update({
        where: { id: user.id },
        data: {
          consentVersion: "legacy-audit",
          consentTermsAt: at,
          consentAgeAt: at,
          consentDataProcessingAt: at,
          consentMarketing: marketing,
          consentMarketingAt: marketing ? at : null,
          consentSms: sms,
          consentSmsAt: sms ? at : null,
        },
      });
    }
    filled++;
    console.log(`  fill  ${user.username} — marketing=${marketing} sms=${sms} at=${at.toISOString()}`);
  }

  console.log(`\n${filled} filled, ${skipped} left unknown.`);
  if (!APPLY) console.log("Dry run — re-run with --apply to write.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
