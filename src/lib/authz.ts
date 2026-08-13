import { NextResponse } from "next/server";
import type { Role } from "@prisma/client";

/**
 * Role-based authorization for API routes. Routes authenticate with
 * `verifyAccessToken` (which never checks role) — this adds the role gate.
 *
 * Usage in a route handler, after verifying the token:
 *
 *   const denied = requireRole(payload, ["HR", "HEAD"]);
 *   if (denied) return denied;
 *
 * Returns a ready-to-return 403 JSON response when the role isn't allowed, or
 * `null` when the user may proceed.
 */
export function requireRole(payload: { role: Role }, allowed: Role[]): NextResponse | null {
  if (!allowed.includes(payload.role)) {
    return NextResponse.json(
      { success: false, message: "You do not have permission to perform this action." },
      { status: 403 },
    );
  }
  return null;
}

/** Boolean variant for server components / data filtering (no HTTP response). */
export function hasRole(role: Role, allowed: Role[]): boolean {
  return allowed.includes(role);
}
