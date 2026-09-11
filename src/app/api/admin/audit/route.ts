/**
 * Read the audit log.
 *
 * The log has been written correctly since the project started and has never once
 * been read back — which makes it evidence nobody can produce. DPDPA compliance
 * rests partly on being able to show who accessed whose personal data, and that
 * requires a way to look.
 *
 * **HEAD only, not HR.** This surfaces every user's activity across the whole
 * platform — who viewed which child's record, every login, every payment. HR
 * legitimately manages students and fees, but a complete cross-platform activity
 * feed is an owner-level capability, and reads of it are themselves audited.
 *
 * Paging is keyset, ordered by `(createdAt desc, id desc)`. `createdAt` is not
 * unique — bulk operations write several rows in the same millisecond — and a
 * cursor on a non-unique column silently skips rows that share a value.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";

const auditQuerySchema = z.object({
  action: z.string().min(1).max(80).optional(),
  userId: z.string().min(1).optional(),
  /** ISO dates, inclusive lower / exclusive upper. */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

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
    const denied = requireRole(payload, ["HEAD"]);
    if (denied) return denied;

    const parsed = auditQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Invalid query", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const { action, userId, from, to, limit, cursor } = parsed.data;

    const where = {
      ...(action ? { action } : {}),
      ...(userId ? { userId } : {}),
      ...(from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } }
        : {}),
    };

    const rows = await db.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        action: true,
        userId: true,
        metadata: true,
        ipAddress: true,
        createdAt: true,
        user: { select: { username: true, role: true } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // The distinct action list powers the filter dropdown. There is no central
    // constant for these — every one is a string literal at its call site — so
    // the database is the only honest source of what actually exists.
    const distinct = await db.auditLog.groupBy({ by: ["action"], _count: true, orderBy: { action: "asc" } });

    await writeAuditLog({
      action: "audit.read",
      userId: payload.userId,
      metadata: { count: page.length, filters: { action: action ?? null, userId: userId ?? null } },
      request,
    });

    return NextResponse.json({
      success: true,
      entries: page.map((r) => ({
        id: r.id,
        action: r.action,
        userId: r.userId,
        username: r.user?.username ?? null,
        role: r.user?.role ?? null,
        metadata: r.metadata,
        ipAddress: r.ipAddress,
        createdAt: r.createdAt,
      })),
      actions: distinct.map((d) => ({ action: d.action, count: d._count })),
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    });
  } catch (error) {
    console.error("[admin/audit] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
