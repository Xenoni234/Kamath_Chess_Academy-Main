import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

/**
 * The server authenticates the cookie at HANDSHAKE time and never again, and
 * the access token lives 15 minutes. That combination has one nasty failure:
 *
 *   1. The tab sleeps, is backgrounded, or Safari reloads it for energy use.
 *      `SessionKeepAlive`'s 10-minute setInterval is throttled or frozen, so
 *      the token expires.
 *   2. The socket drops and socket.io re-handshakes with the stale cookie.
 *   3. `authenticateSocket` returns null and the server calls
 *      `socket.disconnect(true)` — which reaches the client as a disconnect
 *      with reason "io server disconnect".
 *   4. socket.io deliberately does NOT auto-reconnect from that reason.
 *
 * The tab is then offline forever with nothing to show for it: presence stops
 * updating, every emit goes nowhere, and the lobby keeps rendering its locally
 * seeded "1 Player Online" and an eternal "Searching for opponent…". Measured
 * in production: two accounts on two machines, neither able to see the other or
 * be paired, both sidebars stuck at "0 online".
 *
 * So a deliberate server disconnect is treated as "your token is stale": mint a
 * fresh one, then reconnect by hand. Backed off, because if the REFRESH token
 * has also expired this must not become a hot loop — the next navigation
 * redirects to /login, which is the correct answer.
 */
const RETRY_MS = [1000, 3000, 8000, 20000];
let retry = 0;
let recovering = false;

async function reauthenticateAndReconnect() {
  if (recovering) return;
  recovering = true;

  const wait = RETRY_MS[Math.min(retry, RETRY_MS.length - 1)];
  retry += 1;

  try {
    await new Promise((r) => setTimeout(r, wait));
    await fetch("/api/auth/refresh", { method: "POST" });
  } catch {
    // Offline, or the refresh token is genuinely gone. Reconnect anyway — if
    // the cookie is still bad the server disconnects us again and we back off
    // further rather than giving up silently.
  } finally {
    recovering = false;
    socket?.connect();
  }
}

export function getSocket(): Socket {
  if (socket) return socket;

  // SAME ORIGIN, ALWAYS — never an absolute URL from an env var.
  //
  // Socket.io is attached to the very server that served this page
  // (`server.mjs`), so it can never live on another origin, and naming one
  // could only ever be wrong. It was wrong: the build hardcoded the apex,
  // Caddy serves `www.` too with no redirect, and Safari hides the `www.`
  // prefix — so a user on www loaded the page fine (same-site cookie, top-level
  // navigation) while every socket request became cross-origin and was refused:
  //
  //   blocked by CORS policy: 'Access-Control-Allow-Origin' has a value
  //   'https://kamathchessacademy.com' that is not equal to the supplied origin
  //
  // socket.io retried forever, so presence never arrived and no one could be
  // paired. Passing `undefined` connects to `window.location.origin`, which is
  // correct on apex, on www, on localhost, and on any future hostname.
  socket = io(undefined, {
    withCredentials: true,
  });

  socket.on("connect", () => {
    retry = 0;
  });

  socket.on("disconnect", (reason) => {
    // Every other reason (transport close, ping timeout, …) is handled by
    // socket.io's own reconnection. Only the server's deliberate disconnect
    // needs a new token and a manual reconnect.
    if (reason === "io server disconnect") void reauthenticateAndReconnect();
  });

  return socket;
}
