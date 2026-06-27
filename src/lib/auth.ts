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

export function signRefreshToken(payload: TokenPayload) {
  const expiresIn = (process.env.JWT_REFRESH_EXPIRY ?? "7d") as SignOptions["expiresIn"];

  return jwt.sign(payload, getRequiredEnv("JWT_REFRESH_SECRET"), {
    expiresIn,
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
