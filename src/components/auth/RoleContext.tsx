"use client";

import { createContext, useContext } from "react";
import type { Role } from "@prisma/client";

export type SessionUser = {
  userId: string;
  username: string;
  role: Role;
};

const RoleContext = createContext<SessionUser | null>(null);

/**
 * Makes the signed-in user's identity available to client components without a
 * fetch.
 *
 * `(dashboard)/layout.tsx` is an async server component that has already verified
 * the JWT and holds `{ userId, username, role }` — the exact payload
 * `/api/auth/me` returns. Client pages were fetching that endpoint anyway, which
 * meant a round trip before they knew who the user was, and a visible layout
 * shift while they waited: the tournaments page renders its manager controls
 * outside the loading gate, so an HR user watched the "New" button pop in a beat
 * after the rest of the page.
 *
 * The value comes from the server component that already trusted it. Nothing is
 * re-verified here and nothing should be: this is presentation state. Every
 * actual authorisation decision stays on the server, where `requireRole` and
 * `canViewStudent` live — a client that lies to this context gains nothing.
 */
export function RoleProvider({ user, children }: { user: SessionUser; children: React.ReactNode }) {
  return <RoleContext.Provider value={user}>{children}</RoleContext.Provider>;
}

/**
 * The signed-in user. Throws outside the dashboard layout, which is a bug rather
 * than a state to handle — every dashboard page is inside that provider.
 */
export function useSession(): SessionUser {
  const value = useContext(RoleContext);
  if (!value) {
    throw new Error("useSession must be used inside the dashboard layout's RoleProvider.");
  }
  return value;
}

/** Convenience for the common "is this user one of these roles" check. */
export function useHasRole(...roles: Role[]): boolean {
  const { role } = useSession();
  return roles.includes(role);
}
