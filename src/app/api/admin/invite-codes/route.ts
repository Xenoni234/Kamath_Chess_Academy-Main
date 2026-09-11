/**
 * Issue and review coach / academy-staff invite codes.
 *
 * **HEAD only, deliberately not HR.** A code is the authority to create a staff
 * account, so the power to mint one is the power to appoint colleagues. That
 * belongs to the academy owner. HR manages students, batches and fees; it does
 * not get to expand the staff list.
 *
 * Every issue and revocation is audited — who was invited as what, by whom.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { createInviteCode, INVITABLE_ROLES } from "@/lib/inviteCodes";

export const runtime = "nodejs";

const createSchema = z.object({
  role: z.enum(INVITABLE_ROLES),
  note: z.string().trim().max(120).optional(),
  /** Null / omitted means it never expires. */
  expiresInDays: z.coerce.number().int().min(1).max(365).optional(),
});

const querySchema = z.object({
  status: z.enum(["open", "used", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

function auth(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return null;
  try {
    return verifyAccessToken(token);
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const payload = auth(request);
  if (!payload) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  try {
    const denied = requireRole(payload, ["HEAD"]);
    if (denied) return denied;

    const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) {
      return NextResponse.json({ success: false, message: "Invalid query" }, { status: 400 });
    }
    const { status, limit } = parsed.data;

    const codes = await db.inviteCode.findMany({
      where:
        status === "open"
          ? { usedAt: null, revokedAt: null }
          : status === "used"
            ? { usedAt: { not: null } }
            : {},
      orderBy: [{ createdAt: "desc" }],
      take: limit,
      select: {
        id: true,
        code: true,
        role: true,
        note: true,
        usedAt: true,
        revokedAt: true,
        expiresAt: true,
        createdAt: true,
        usedBy: { select: { username: true, email: true } },
        createdBy: { select: { username: true } },
      },
    });

    const open = await db.inviteCode.count({ where: { usedAt: null, revokedAt: null } });

    return NextResponse.json({ success: true, codes, open });
  } catch (error) {
    console.error("[admin/invite-codes] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const payload = auth(request);
  if (!payload) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  try {
    const denied = requireRole(payload, ["HEAD"]);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, message: "Invalid request body" }, { status: 400 });
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const created = await createInviteCode({
      role: parsed.data.role,
      createdById: payload.userId,
      note: parsed.data.note,
      expiresInDays: parsed.data.expiresInDays ?? null,
    });

    await writeAuditLog({
      action: "invite.create",
      userId: payload.userId,
      // The code itself is not logged: the audit log is readable by the head, and
      // a live invite sitting in it is one more place it can leak from.
      metadata: { inviteId: created.id, role: parsed.data.role, note: parsed.data.note ?? null },
      request,
    });

    return NextResponse.json({ success: true, code: created.code, id: created.id }, { status: 201 });
  } catch (error) {
    console.error("[admin/invite-codes] POST failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
