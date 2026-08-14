"use client";

import { useEffect } from "react";

/**
 * Keeps the access cookie fresh while a dashboard tab is open.
 *
 * `JWT_ACCESS_EXPIRY` is 15 minutes and nothing in the app ever called
 * `/api/auth/refresh` — the 7-day refresh token was dead code. Anyone who spent
 * longer than 15 minutes on one page was silently logged out of *every*
 * endpoint, which generating a dossier (5-10 minutes, then reading it) made
 * very easy to hit. The symptom was a bare "Unauthorized" that looked like the
 * feature had failed.
 *
 * This refreshes well inside the window rather than reacting to a 401, so no
 * request ever fails in the first place. A tab that was closed past the refresh
 * window still lands on /login via the proxy, which is the correct outcome.
 */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export default function SessionKeepAlive() {
  useEffect(() => {
    // No refresh on mount: the token was just minted or is still valid, and a
    // burst of refreshes on every navigation would be pointless load.
    const id = setInterval(() => {
      void fetch("/api/auth/refresh", { method: "POST" }).catch(() => {
        // Offline or the refresh token has genuinely expired — the next
        // navigation redirects to /login, which is the right answer.
      });
    }, REFRESH_INTERVAL_MS);

    return () => clearInterval(id);
  }, []);

  return null;
}
