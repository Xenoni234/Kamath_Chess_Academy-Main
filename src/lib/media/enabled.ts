/**
 * Is the mediasoup SFU active?
 *
 * This lives in its own module, with no imports, for one reason: the Next route
 * handler needs the answer but must never import `lib/media/mediasoup.ts`, which
 * pulls in the native mediasoup binding that only exists inside the custom
 * Socket.io server process. The logic was previously copy-pasted into both, which
 * is two sources of truth for a security-relevant switch — if they ever drifted,
 * the page would offer a video mode the server would refuse to serve.
 *
 * Tri-state on purpose:
 *   "false" -> off, always.
 *   "true"  -> on, always.
 *   unset   -> on in development (127.0.0.1 works for two-tab testing on one
 *              machine), OFF in production, because a production SFU needs a
 *              public announced IP, an open UDP range and a TURN server. Failing
 *              closed means an unconfigured deploy falls back to the embedded
 *              call rather than silently serving video nobody can connect to.
 */
export function mediaEnabledFromEnv(): boolean {
  if (process.env.MEDIASOUP_ENABLED === "false") return false;
  if (process.env.MEDIASOUP_ENABLED === "true") return true;
  return process.env.NODE_ENV !== "production";
}
