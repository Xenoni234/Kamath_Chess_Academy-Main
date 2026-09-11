import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { redis } from "@/lib/redis";
import { contactSchema } from "@/lib/validations";

/**
 * Per-IP cap on enquiries. Deliberately generous — a family filling in the form
 * twice must not be blocked — but enough to stop a script exhausting the Resend
 * quota or filling the staff inbox with junk.
 *
 * It FAILS OPEN. If Redis is unreachable the enquiry is accepted anyway: this is
 * the academy's only inbound lead channel and a cache outage silently swallowing
 * real enquiries is far worse than letting a flood through.
 */
const MAX_PER_IP_HOUR = 5;

async function rateLimited(request: Request): Promise<boolean> {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const key = `rate:contact:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 3600);
    return count > MAX_PER_IP_HOUR;
  } catch (error) {
    console.error("[contact] rate limit unavailable, allowing through:", error);
    return false;
  }
}

export async function POST(request: Request) {
  try {
    if (await rateLimited(request)) {
      return NextResponse.json(
        { success: false, message: "Too many enquiries from this connection. Please try again later." },
        { status: 429 },
      );
    }

    const body = await request.json();

    const result = contactSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: "Validation failed.",
          errors: result.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const { name, email, mobile, message } = result.data;

    // Persist first. An enquiry that only ever existed in stdout is a lost lead,
    // and printing a member of the public's name/email/mobile into the log
    // aggregator is exactly the disclosure the consent copy promises not to make.
    const saved = await db.contactMessage.create({
      data: { name, email, mobile: mobile || null, message },
      select: { id: true },
    });

    // Then notify the academy. A mail failure must not lose the enquiry, so this
    // runs after the write and is caught.
    const notifyTo = process.env.CONTACT_NOTIFY_EMAIL || process.env.EMAIL_FROM;
    if (notifyTo) {
      const notified = await sendEmail({
        to: notifyTo,
        replyTo: email,
        subject: `New enquiry from ${name}`,
        html: `<div style="font-family:system-ui,sans-serif">
  <h3 style="margin:0 0 8px">New website enquiry</h3>
  <p style="margin:0 0 4px"><strong>Name:</strong> ${escapeHtml(name)}</p>
  <p style="margin:0 0 4px"><strong>Email:</strong> ${escapeHtml(email)}</p>
  ${mobile ? `<p style="margin:0 0 4px"><strong>Mobile:</strong> ${escapeHtml(mobile)}</p>` : ""}
  <p style="margin:12px 0 0;white-space:pre-wrap">${escapeHtml(message)}</p>
</div>`,
      });
      // The enquiry is already saved and readable in the staff inbox, so a failed
      // notification is a delay, not a lost lead. It still has to be logged —
      // silently dropping it is how the OTP bug went unnoticed for a day.
      if (!notified.sent) {
        console.warn(`[contact] enquiry ${saved.id} saved but the notification failed: ${notified.error}`);
      }
    } else {
      console.warn(`[contact] enquiry ${saved.id} saved but nobody was notified — set CONTACT_NOTIFY_EMAIL`);
    }

    console.log(`[contact] enquiry ${saved.id} received`);

    return NextResponse.json(
      {
        success: true,
        message: "Your message has been received. Thank you!",
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error processing contact form submission:", error);
    return NextResponse.json(
      {
        success: false,
        message: "An internal server error occurred while processing your request.",
      },
      { status: 500 }
    );
  }
}

/** Escape user text before embedding it in the notification email's HTML. */
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}
