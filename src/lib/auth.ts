import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import type { Role } from "@prisma/client";

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

export function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export function comparePassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}
