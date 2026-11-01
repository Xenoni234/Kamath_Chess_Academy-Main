import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { clientIp } from "./http/clientIp";

/**
 * Append an entry to the AuditLog. India's DPDPA 2023 requires that all access
 * to a data principal's personal data be recorded — in this app that means
 * every parent/coach/HR read of a (often-minor) student's records, plus exports
 * and account changes. Pass a `request` to capture IP + user agent.
 *
 * Best-effort and non-throwing: a logging failure must never break the request
 * it is auditing.
 *
 * The address comes from `clientIp`, which reads the LAST `X-Forwarded-For` hop. This used
 * to take the first, which is supplied by the caller — so the one record meant to prove who
 * touched a child's data stored whatever address the caller chose to send.
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
        ipAddress: params.request ? clientIp(params.request) : null,
        userAgent: headers?.get("user-agent") ?? null,
      },
    });
  } catch (error) {
    console.error("[audit] failed to write audit log:", error);
  }
}
