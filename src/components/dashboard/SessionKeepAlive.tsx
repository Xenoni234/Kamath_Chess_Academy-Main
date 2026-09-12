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

/**
 * The interval alone is not enough. Browsers throttle timers hard in background
 * tabs and stop them entirely while the machine sleeps, so the very situations
 * that outlast a 15-minute token are the ones where this never fires. A laptop
 * closed for twenty minutes wakes with an expired cookie, the socket
 * re-handshakes with it, and the server drops the connection — which is how two
 * accounts ended up unable to see each other in the lobby.
 *
 * So also refresh when the tab becomes visible again or the network returns,
 * rate-limited so that flicking between tabs does not hammer the endpoint.
 */
const MIN_GAP_MS = 60 * 1000;

/**
 * Shared across mounts, deliberately. The interval was anchored to MOUNT time while the
 * token's 15 minutes run from ISSUE time, so navigating to a page when the cookie was
 * already 6+ minutes old left a window where it expired BEFORE the first refresh fired —
 * and nothing recovered, because "no refresh on mount" was the rule.
 *
 * That window was harmless while every page finished its work in seconds. A game report
 * now polls for a quarter of an hour, which crosses it almost every time: the student sees
 * a red "Unauthorized" appear over a report that is building perfectly well.
 *
 * So refresh on mount too, and keep the last refresh time at module scope so moving
 * between dashboard pages does not turn that into a burst on every navigation.
 */
let lastRefreshAt = 0;

export default function SessionKeepAlive() {
  useEffect(() => {
    let last = lastRefreshAt;

    const refresh = () => {
      last = Date.now();
      lastRefreshAt = last;
      void fetch("/api/auth/refresh", { method: "POST" }).catch(() => {
        // Offline or the refresh token has genuinely expired — the next
        // navigation redirects to /login, which is the right answer.
      });
    };

    // Refresh on mount unless another page did so moments ago. The client cannot read an
    // httpOnly cookie's age, so it cannot know whether the token has 14 minutes left or
    // 30 seconds — assuming the optimistic case is exactly what produced the bug above.
    if (Date.now() - lastRefreshAt >= MIN_GAP_MS) refresh();

    const id = setInterval(refresh, REFRESH_INTERVAL_MS);

    const onWake = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - last < MIN_GAP_MS) return;
      refresh();
    };

    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
    };
  }, []);

  return null;
}
