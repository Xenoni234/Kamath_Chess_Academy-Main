import { randomBytes, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import type { Role } from "@prisma/client";
// RELATIVE, with the explicit `.ts` extension — not the `@/` alias, and not extensionless.
//
// This file is loaded two completely different ways. Next bundles it for the API routes,
// where `@/` resolves fine. But `server.mjs` also does `await import('./src/lib/socket/
// server.js')`, which is raw Node ESM with no bundler and no tsconfig path mapping, and that
// chain reaches here through `socket/server.ts`'s `import … from "../auth.ts"`.
//
// An `@/` import here therefore throws `Cannot find package '@/lib'` at RUNTIME and takes the
// whole Socket.io server down with it — live games, clocks, class rooms, presence and
// notifications — while `tsc`, `eslint` and `npm run build` all pass, because every one of
// those goes through the bundler. Only starting the server catches it.
import { compareInPool, hashInPool } from "./password/hashPool.ts";

export type TokenPayload = {
  userId: string;
  username: string;
  role: Role;
};

function getRequiredEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is not configured`);
  }

  return value;
}

export function signAccessToken(payload: TokenPayload) {
  const expiresIn = (process.env.JWT_ACCESS_EXPIRY ?? "15m") as SignOptions["expiresIn"];

  return jwt.sign(payload, getRequiredEnv("JWT_SECRET"), {
    expiresIn,
  });
}

/**
 * A refresh token, unique to this call.
 *
 * `jwtid` is NOT decoration. Without it the signed payload is `{userId, username, role}`
 * plus `iat`/`exp`, both of which are whole SECONDS — so two logins by the same account in
 * the same second produced a BYTE-IDENTICAL token, and `UserSession.refreshToken` is
 * `@unique`. The insert then died with P2002 and the whole login returned 500 having
 * already paid for the password hash and the database round trips.
 *
 * That is not only an attack symptom. It fires for a student who double-clicks "Sign in",
 * and for one account signed in on a phone and a laptop at the same moment. It also meant
 * a "session" was not per-login at all: two devices could not be told apart or revoked
 * separately, which is the entire point of the session table.
 *
 * `randomUUID` rather than a counter: the row is the session identity, so it must not be
 * guessable or repeat across restarts.
 */
export function signRefreshToken(payload: TokenPayload) {
  const expiresIn = (process.env.JWT_REFRESH_EXPIRY ?? "7d") as SignOptions["expiresIn"];

  return jwt.sign(payload, getRequiredEnv("JWT_REFRESH_SECRET"), {
    expiresIn,
    jwtid: randomUUID(),
  });
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, getRequiredEnv("JWT_SECRET")) as TokenPayload & jwt.JwtPayload;
}

export function verifyRefreshToken(token: string) {
  return jwt.verify(token, getRequiredEnv("JWT_REFRESH_SECRET")) as TokenPayload & jwt.JwtPayload;
}

/**
 * Both of these now run in worker threads — see `src/lib/password/hashPool.ts` for why, and
 * do not "simplify" them back to calling bcryptjs directly. bcryptjs is pure JavaScript, so
 * a cost-12 hash blocks the single event loop for ~200 ms, and an unmetered login route took
 * the entire platform down with that on 10 Oct 2026.
 *
 * The signatures are unchanged and the hashes are unchanged bcrypt (bcryptjs v3 emits the
 * `$2b$` prefix; `$2a$` rows verify identically), so all nine call sites — including the
 * `scripts/*` that seed accounts — need no edit.
 */
export function hashPassword(password: string) {
  return hashInPool(password);
}

export function comparePassword(password: string, passwordHash: string) {
  return compareInPool(password, passwordHash);
}

/**
 * A password comparison that always fails, but costs what a real one costs.
 *
 * `POST /api/auth/login` returns early when the username does not exist, so a wrong-username
 * attempt was fast and a wrong-password-on-a-real-account attempt was slow. That difference is
 * a **user-enumeration oracle**: anyone can discover which accounts exist by timing the
 * response, which for an academy means discovering which children are enrolled.
 *
 * The decoy is hashed once, lazily, from random bytes nobody holds — it is not a credential and
 * nothing can authenticate against it. It is cached because generating it per request would
 * double the cost of the very route being protected.
 *
 * This is only affordable because hashing now happens off the event loop
 * (`src/lib/password/hashPool.ts`). Doing it while bcryptjs still ran on the main thread would
 * have meant handing an attacker 200 ms of blocked loop per NONEXISTENT username too, which is
 * the opposite of the fix.
 */
let decoyHash: Promise<string> | null = null;

export async function compareAgainstDecoy(password: string): Promise<false> {
  decoyHash ??= hashInPool(randomBytes(32).toString("hex"));
  await compareInPool(password, await decoyHash);
  return false;
}
