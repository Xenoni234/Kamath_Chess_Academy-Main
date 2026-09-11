/**
 * Parent codes: how a parent proves they are a parent of *that* student.
 *
 * The problem this solves. PARENT is a self-service role, and a parent account
 * exists to read one child's attendance, reports, fees and game history. If
 * signing up as a parent only needed a form, anyone could register as the parent
 * of any student whose username they could guess, and read a child's records.
 *
 * So registration as a parent requires **two things that only the family has**:
 * the student's username, and a code shown on that student's own dashboard. The
 * username alone is guessable; the code alone is meaningless without knowing who
 * it belongs to. Together they are a claim the student had to have shared.
 *
 * Reusable on purpose — most children have two parents, and issuing one code per
 * parent would mean a student generating a second one they cannot tell apart.
 * The student can regenerate instead, which invalidates the old code everywhere.
 */
import crypto from "node:crypto";
import { db } from "@/lib/db";

/** No O/0, I/1, S/5, B/8 — these get read aloud across a kitchen table. */
const ALPHABET = "ACDEFGHJKLMNPQRTUVWXYZ2346789";

function block(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return out;
}

export function generateParentCode(): string {
  return `${block(3)}-${block(3)}`;
}

/**
 * The student's code, generating one on first read.
 *
 * Lazy rather than created with the account, so existing students need no
 * backfill and a student who never shares one never has one sitting in the
 * database.
 */
export async function getOrCreateParentCode(userId: string): Promise<string | null> {
  const profile = await db.studentProfile.findUnique({
    where: { userId },
    select: { id: true, parentCode: true },
  });
  if (!profile) return null;
  if (profile.parentCode) return profile.parentCode;

  for (let attempt = 0; attempt < 5; attempt++) {
    const parentCode = generateParentCode();
    try {
      const updated = await db.studentProfile.update({
        where: { id: profile.id },
        data: { parentCode },
        select: { parentCode: true },
      });
      return updated.parentCode;
    } catch {
      // P2002 — collision on the unique index. Try another.
    }
  }
  throw new Error("Could not allocate an unused parent code.");
}

/** Replace the code, invalidating whatever was shared before. */
export async function regenerateParentCode(userId: string): Promise<string | null> {
  const profile = await db.studentProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!profile) return null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const parentCode = generateParentCode();
    try {
      const updated = await db.studentProfile.update({
        where: { id: profile.id },
        data: { parentCode },
        select: { parentCode: true },
      });
      return updated.parentCode;
    } catch {
      /* collision — retry */
    }
  }
  throw new Error("Could not allocate an unused parent code.");
}

export type ParentClaim = { ok: true; studentId: string } | { ok: false; reason: string };

/**
 * Check a (student username, parent code) pair.
 *
 * Both wrong-username and wrong-code return the **same** message on purpose. A
 * distinct "no such student" would turn this into a username oracle, and a
 * distinct "wrong code" would confirm a username is real — either way an attacker
 * learns which children exist on the platform.
 */
export async function resolveParentClaim(params: {
  studentUsername: string;
  parentCode: string;
}): Promise<ParentClaim> {
  const username = params.studentUsername.trim();
  const code = params.parentCode.trim().toUpperCase();
  const generic = "That student name and parent code don't match. Check both with the student.";

  if (!username || !code) return { ok: false, reason: generic };

  const profile = await db.studentProfile.findUnique({
    where: { parentCode: code },
    select: { userId: true, user: { select: { username: true, role: true, isActive: true } } },
  });

  if (!profile) return { ok: false, reason: generic };
  if (profile.user.username.toLowerCase() !== username.toLowerCase()) return { ok: false, reason: generic };
  if (profile.user.role !== "STUDENT") return { ok: false, reason: generic };
  if (!profile.user.isActive) return { ok: false, reason: generic };

  return { ok: true, studentId: profile.userId };
}
