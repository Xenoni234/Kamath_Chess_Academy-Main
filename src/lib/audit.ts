import type { Prisma } from "@prisma/client";
import { db } from "./db";

/**
 * Append an entry to the AuditLog. India's DPDPA 2023 requires that all access
 * to a data principal's personal data be recorded — in this app that means
 * every parent/coach/HR read of a (often-minor) student's records, plus exports
 * and account changes. Pass a `request` to capture IP + user agent.
 *
 * Best-effort and non-throwing: a logging failure must never break the request
 * it is auditing.
 */
export async function writeAuditLog(params: {
  action: string;
  userId?: string | null;
  metadata?: Prisma.InputJsonValue;
  request?: Request;
}): Promise<void> {
  try {
    const headers = params.request?.headers;
    await db.auditLog.create({
      data: {
        action: params.action,
        userId: params.userId ?? null,
        metadata: params.metadata,
        ipAddress: headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        userAgent: headers?.get("user-agent") ?? null,
      },
    });
  } catch (error) {
    console.error("[audit] failed to write audit log:", error);
  }
}
