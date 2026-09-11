/**
 * Prove that mail actually leaves the building.
 *
 *   npx tsx --env-file=.env.local scripts/sendTestEmail.ts someone@example.com
 *
 * "Domain verified" in Resend's dashboard means the DNS records resolve. It does
 * NOT mean a message reaches a stranger's inbox — that additionally needs
 * EMAIL_FROM to be on the verified domain, a live API key, and the message not to
 * be refused. Registration cannot work until all of those are true, and the way
 * this broke before was silent: Resend *returns* an error object rather than
 * throwing, so every caller that ignored the return value looked successful.
 *
 * So send to an address that is NOT your own — sending to the account owner works
 * even on an unverified domain, which is exactly the false positive that hid the
 * problem for weeks.
 */
import { sendEmail } from "../src/lib/email";

const to = process.argv[2];

if (!to || !to.includes("@")) {
  console.error("Usage: npx tsx --env-file=.env.local scripts/sendTestEmail.ts you@example.com");
  process.exit(1);
}

async function main() {
  console.log(`From : ${process.env.EMAIL_FROM ?? "(EMAIL_FROM is not set)"}`);
  console.log(`Reply: ${process.env.EMAIL_REPLY_TO ?? "(none)"}`);
  console.log(`To   : ${to}\n`);

  if (!process.env.EMAIL_FROM?.includes("kamathchessacademy.com")) {
    console.warn("⚠️  EMAIL_FROM is not on the verified domain — this will likely be refused.\n");
  }

  const result = await sendEmail({
    to,
    subject: "Kamath Chess Academy — test message",
    html: `<p>If you are reading this, the academy can send email to anyone.</p>
           <p>This is the same path registration OTPs, invoices and reports take.</p>`,
  });

  if (result.sent) {
    console.log("✅ Resend accepted it. Check the inbox — and the spam folder.");
    console.log("   If it landed in spam, that is a reputation warm-up issue, not a config one.");
  } else {
    console.log(`❌ Refused: ${result.error}`);
    console.log("   This is the exact failure that made registration return 400 for everyone.");
  }
  process.exit(result.sent ? 0 : 1);
}

main();
