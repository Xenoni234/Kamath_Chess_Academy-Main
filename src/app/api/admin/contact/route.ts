/**
 * The staff contact inbox.
 *
 * This exists because the privacy policy tells people to exercise their DPDPA
 * rights "through the form on our website" — and until now that form wrote to a
 * table no code ever read. The only signal anyone got was a notification email
 * that fires only when EMAIL_FROM is configured. An unread rights channel is a
 * worse compliance posture than no channel at all, because it is a promise that
 * cannot be kept.
 *
 * Reads are audited: these are members of the public's names, emails and phone
 * numbers, and staff access to personal data belongs in the log like any other.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { contactQuerySchema } from "@/lib/validations/compliance";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const denied = requireRole(payload, ["HR", "HEAD"]);
    if (denied) return denied;

    const parsed = contactQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Invalid query", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const { handled, limit, cursor } = parsed.data;

    const messages = await db.contactMessage.findMany({
      where: handled === "all" ? {} : { handled: handled === "true" },
      // id breaks ties: createdAt is not unique, and a cursor on a non-unique
      // column silently skips rows when two share a timestamp.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, name: true, email: true, mobile: true, message: true, handled: true, createdAt: true },
    });

    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(0, limit) : messages;

    const unhandled = await db.contactMessage.count({ where: { handled: false } });

    await writeAuditLog({
      action: "contact.list",
      userId: payload.userId,
      metadata: { count: page.length, filter: handled },
      request,
    });

    return NextResponse.json({
      success: true,
      messages: page,
      unhandled,
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    });
  } catch (error) {
    console.error("[admin/contact] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
