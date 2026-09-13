/**
 * Withdraw an unused invite code.
 *
 * A DELETE would be wrong here. Once a code is used it is a record of who the
 * academy appointed and when, and that should survive; and an unused code that
 * was handed out and then withdrawn is itself worth remembering. So revocation
 * stamps `revokedAt` and leaves the row.
 *
 * An already-redeemed code cannot be revoked — the account exists, and taking it
 * away is a role change in the People console, not an invite operation.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const denied = requireRole(payload, ["HEAD"]);
    if (denied) return denied;

    const { id } = await context.params;
    const existing = await db.inviteCode.findUnique({
      where: { id },
      select: { id: true, role: true, usedAt: true, revokedAt: true },
    });

    if (!existing) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }
    if (existing.usedAt) {
      return NextResponse.json(
        { success: false, message: "That code has already been used — change the account's role instead." },
        { status: 409 },
      );
    }

    /**
     * `?hard=1` removes the row instead of marking it revoked.
     *
     * Revoking is the right default: a code that was issued and withdrawn is a record of
     * an intent to grant staff access, and keeping it means the list shows what happened.
     * But a withdrawn code then sits in the list forever with nothing to do about it, so
     * there has to be a way to tidy up.
     *
     * Only ever for codes that were NEVER USED — that is the check above, and it is what
     * keeps this from being a way to erase the trail of who was granted staff access. A
     * used code is history and stays.
     */
    if (request.nextUrl.searchParams.get("hard") === "1") {
      await db.inviteCode.delete({ where: { id } });
      await writeAuditLog({
        action: "invite.delete",
        userId: payload.userId,
        metadata: { inviteId: id, role: existing.role, wasRevoked: Boolean(existing.revokedAt) },
        request,
      });
      return NextResponse.json({ success: true, deleted: true });
    }

    if (existing.revokedAt) {
      return NextResponse.json({ success: true, alreadyRevoked: true });
    }

    await db.inviteCode.update({ where: { id }, data: { revokedAt: new Date() } });

    await writeAuditLog({
      action: "invite.revoke",
      userId: payload.userId,
      metadata: { inviteId: id, role: existing.role },
      request,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[admin/invite-codes/[id]] DELETE failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
