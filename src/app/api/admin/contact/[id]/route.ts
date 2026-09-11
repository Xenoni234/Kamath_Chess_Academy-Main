/**
 * Mark a contact enquiry handled (or reopen it).
 *
 * `ContactMessage.handled` existed in the schema from the start and was never
 * read or written by any code — the only way to change it was the Supabase
 * console. Without this, "handled" is decoration and the inbox grows forever.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { contactUpdateSchema } from "@/lib/validations/compliance";

export const runtime = "nodejs";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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

    const { id } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, message: "Invalid request body" }, { status: 400 });
    }

    const parsed = contactUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const existing = await db.contactMessage.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }

    const updated = await db.contactMessage.update({
      where: { id },
      data: { handled: parsed.data.handled },
      select: { id: true, handled: true },
    });

    await writeAuditLog({
      action: "contact.handle",
      userId: payload.userId,
      metadata: { contactId: id, handled: parsed.data.handled },
      request,
    });

    return NextResponse.json({ success: true, message: updated });
  } catch (error) {
    console.error("[admin/contact/[id]] PATCH failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
