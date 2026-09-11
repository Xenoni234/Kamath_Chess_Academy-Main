/**
 * The one place email is sent.
 *
 * It exists because of a bug that cost an afternoon: **the Resend SDK does not
 * throw when the API rejects a message.** `resend.emails.send()` resolves with
 * `{ data: null, error: {...} }`, and every call site in this codebase was
 * written as `await resend.emails.send({...})` with the result discarded. So a
 * rejected send was indistinguishable from a successful one.
 *
 * What that looked like in practice: registration told the user "Code sent to
 * your@email.com. It expires in 10 minutes", stored a matching code row, and
 * returned 200 — while Resend had answered
 *
 *     403 — You can only send testing emails to your own email address
 *
 * because the project was still on the `onboarding@resend.dev` test sender. No
 * error appeared in any log. The user waited for an email that was never going
 * to arrive, with nothing anywhere to explain it.
 *
 * So: every send goes through here, the result is inspected, and a failure is a
 * failure. Callers get a typed result rather than a lie.
 */
import type { Resend } from "resend";

export type EmailResult = { sent: true; id: string | null } | { sent: false; error: string };

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  /** Where a reply should go — used so staff can answer an enquiry directly. */
  replyTo?: string;
  attachments?: { filename: string; content: Buffer }[];
};

/**
 * Send one message, honestly.
 *
 * Never throws — callers decide whether a failed email is fatal (a verification
 * code) or merely unfortunate (a copy of an invoice that is also downloadable).
 * Both kinds exist here, and both need to be able to tell the difference.
 */
export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const from = process.env.EMAIL_FROM;
  if (!from) {
    console.error("[email] EMAIL_FROM is not configured — nothing can be sent");
    return { sent: false, error: "Email sending is not configured." };
  }
  if (!process.env.RESEND_API_KEY) {
    console.error("[email] RESEND_API_KEY is not configured — nothing can be sent");
    return { sent: false, error: "Email sending is not configured." };
  }

  // Lazily constructed: a missing key should fail the send, not the import.
  const { Resend: ResendClient } = await import("resend");
  const resend: Resend = new ResendClient(process.env.RESEND_API_KEY);

  try {
    const result = await resend.emails.send({
      from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      // Replies go to a mailbox a human actually reads.
      //
      // `from` must be an address on a domain verified with the mail provider —
      // a Gmail address can never be a `from`, because nobody but Google can add
      // DNS records to gmail.com. So the academy sends as noreply@its-own-domain
      // and points replies at its real inbox. A per-message replyTo (the contact
      // form pointing at the enquirer) still wins over the default.
      ...(message.replyTo ?? process.env.EMAIL_REPLY_TO
        ? { replyTo: message.replyTo ?? process.env.EMAIL_REPLY_TO! }
        : {}),
      ...(message.attachments ? { attachments: message.attachments } : {}),
    });

    // THE POINT OF THIS FILE. An API rejection arrives here, not in the catch.
    if (result.error) {
      const detail = result.error.message ?? String(result.error);
      console.error(`[email] Resend refused "${message.subject}" to ${message.to}: ${detail}`);
      return { sent: false, error: detail };
    }

    return { sent: true, id: result.data?.id ?? null };
  } catch (error) {
    // Network-level failure — the SDK does throw for these.
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[email] could not reach Resend for "${message.subject}" to ${message.to}: ${detail}`);
    return { sent: false, error: detail };
  }
}
