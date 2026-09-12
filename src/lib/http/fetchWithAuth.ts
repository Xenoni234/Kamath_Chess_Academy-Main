/**
 * `fetch` for authenticated client pages, which survives the access token expiring
 * underneath a long-lived page.
 *
 * The access cookie lives 15 minutes. `SessionKeepAlive` refreshes it, but no refresh
 * schedule can be airtight: browsers throttle timers in background tabs and stop them
 * while the machine sleeps, and the client cannot read an httpOnly cookie's age to know
 * how much of the window is left.
 *
 * That was harmless while every page finished its work in seconds. Then a game report
 * started polling for a quarter of an hour and a dossier for half an hour, and the gap
 * became near-certain to be crossed: a student watched a red "Unauthorized" appear over a
 * report that was building perfectly well.
 *
 * A 401 on a page the user is actively looking at is therefore treated as "the cookie
 * aged out", not "you are signed out" — refresh once, retry once. If the retry also 401s
 * the session is genuinely gone and the caller handles it; the proxy sends the next
 * navigation to /login, which is the correct outcome.
 *
 * Deliberately NOT a retry-everything wrapper: exactly one refresh and one retry, only on
 * 401, so a genuinely expired session cannot turn into a loop.
 *
 * **Retrying a POST is safe here, and that is not an accident.** Every route in this app
 * authenticates in its own small `try` that returns 401 BEFORE touching the database (see
 * "the catch-all 401 is gone" in AGENTS.md), so a 401 response means nothing happened —
 * no attendance marked, no dossier queued, no payment recorded. If a route is ever written
 * that does work before authenticating, that ordering breaks and this retry would
 * duplicate it. Keep the auth check first.
 *
 * Bodies must be replayable — a string or FormData, not a ReadableStream — because the
 * retry re-sends `init` as given. Every caller in this codebase passes JSON.stringify.
 *
 * Auth endpoints are NOT wrapped: a 401 from /api/auth/* is the real answer, and wrapping
 * the refresh call itself would recurse.
 */

/** Shared across callers so a burst of parallel polls triggers one refresh, not five. */
let inFlightRefresh: Promise<boolean> | null = null;

function refreshOnce(): Promise<boolean> {
  inFlightRefresh ??= fetch("/api/auth/refresh", { method: "POST" })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      inFlightRefresh = null;
    });
  return inFlightRefresh;
}

export async function fetchWithAuth(input: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status !== 401) return response;

  const refreshed = await refreshOnce();
  if (!refreshed) return response;

  return fetch(input, init);
}
