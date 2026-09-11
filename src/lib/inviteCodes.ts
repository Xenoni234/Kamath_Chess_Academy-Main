/**
 * Invite codes for coach and academy-staff registration.
 *
 * Anyone may pick "Coach" or "Academy staff" in the sign-up dropdown, but they
 * must also present a code the head issued beforehand. That is what stops a
 * public form from handing a stranger the student roster, attendance and fee
 * records.
 *
 * Two properties this file exists to guarantee:
 *
 * **Single use, under a race.** `consumeInviteCode` does not read-then-write. It
 * issues one conditional `updateMany` predicated on `usedAt` still being null, so
 * two people redeeming the same code at the same instant produce exactly one
 * success — Postgres serialises the row update and the loser matches zero rows.
 * A check-then-update would let both through.
 *
 * **The code must match the role being claimed.** A code issued for a coach
 * cannot be redeemed for an academy-staff account, which would otherwise be a
 * quiet privilege upgrade on a code the head handed out in good faith.
 */
import crypto from "node:crypto";
import type { Role } from "@prisma/client";
import { db } from "@/lib/db";

/** Roles an invite code can grant. Never HEAD — that is the owner account. */
export const INVITABLE_ROLES = ["COACH", "HR"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

/**
 * Unambiguous alphabet: no O/0, I/1, S/5, B/8.
 *
 * These codes get read aloud, written on paper and typed by someone who did not
 * choose them. "Is that an O or a zero" is a support message nobody needs.
 */
const ALPHABET = "ACDEFGHJKLMNPQRTUVWXYZ2346789";

function block(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    // randomInt, not Math.random: this string is the only thing standing between
    // a stranger and a staff account.
    out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  }
  return out;
}

export function generateCode(): string {
  return `KCA-${block(4)}-${block(4)}`;
}

export type InviteCheck =
  | { ok: true; id: string }
  | { ok: false; reason: string };

/**
 * Check a code without consuming it.
 *
 * Used before the account is created, so a bad code produces a clean 400 with a
 * field error instead of a half-made user that has to be cleaned up. It is
 * explicitly NOT the security boundary — `consumeInviteCode` is, because only the
 * conditional update is safe against two people redeeming at once. This is the
 * courteous early exit; that is the lock.
 */
export async function peekInviteCode(params: { code: string; role: Role }): Promise<InviteCheck> {
  const code = params.code.trim().toUpperCase();
  if (!code) return { ok: false, reason: "An invite code is required for that role." };

  const existing = await db.inviteCode.findUnique({
    where: { code },
    select: { id: true, role: true, usedAt: true, revokedAt: true, expiresAt: true },
  });

  if (!existing) return { ok: false, reason: "That invite code was not recognised." };
  if (existing.revokedAt) return { ok: false, reason: "That invite code has been withdrawn." };
  if (existing.usedAt) return { ok: false, reason: "That invite code has already been used." };
  if (existing.expiresAt && existing.expiresAt < new Date()) {
    return { ok: false, reason: "That invite code has expired. Ask the academy for a new one." };
  }
  if (existing.role !== params.role) {
    return { ok: false, reason: "That invite code is not valid for the role you selected." };
  }
  return { ok: true, id: existing.id };
}

/**
 * Redeem a code for `role`, atomically.
 *
 * Returns the row id on success so the caller can attach the new user to it.
 * Every failure reason is deliberately specific — these messages go to someone
 * the academy invited, who mistyped a code or left it too long, not to an
 * attacker probing for valid codes (a code is 8 characters from a 29-letter
 * alphabet; guessing is not the threat model here).
 */
export async function consumeInviteCode(params: {
  code: string;
  role: Role;
  userId: string;
}): Promise<InviteCheck> {
  const checked = await peekInviteCode({ code: params.code, role: params.role });
  if (!checked.ok) return checked;

  // The claim. Conditional on still being unused, so a concurrent redemption of
  // the same code updates zero rows and is rejected below. This — not the peek
  // above — is what makes a code single-use.
  const claimed = await db.inviteCode.updateMany({
    where: { id: checked.id, usedAt: null, revokedAt: null },
    data: { usedAt: new Date(), usedById: params.userId },
  });

  if (claimed.count !== 1) {
    return { ok: false, reason: "That invite code has already been used." };
  }

  return { ok: true, id: checked.id };
}

/** Mint a code. Collisions are astronomically unlikely but retried rather than thrown. */
export async function createInviteCode(params: {
  role: InvitableRole;
  createdById: string;
  note?: string | null;
  expiresInDays?: number | null;
}): Promise<{ id: string; code: string }> {
  const expiresAt =
    params.expiresInDays && params.expiresInDays > 0
      ? new Date(Date.now() + params.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      const row = await db.inviteCode.create({
        data: {
          code,
          role: params.role,
          note: params.note?.trim() || null,
          createdById: params.createdById,
          expiresAt,
        },
        select: { id: true, code: true },
      });
      return row;
    } catch (error) {
      // P2002 on `code` — try again with a different one.
      const isDuplicate =
        typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002";
      if (!isDuplicate) throw error;
    }
  }
  throw new Error("Could not allocate an unused invite code.");
}
