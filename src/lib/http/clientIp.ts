/**
 * Who is actually calling — as observed by our own proxy, not as claimed by the caller.
 *
 * Lives in its own module because it is not a rate-limiting concern: the audit log depends
 * on it too, and getting it wrong there means an attacker chooses what gets recorded about
 * them in the DPDPA evidence trail.
 */
/**
 * The client's address, as seen by OUR proxy — not as claimed by the client.
 *
 * `X-Forwarded-For` is a list that each hop APPENDS to, so the leftmost entry is whatever
 * the client sent and the rightmost is what the nearest trusted proxy observed. Caddy is
 * the only ingress (the app publishes no ports, only `expose`), so the last element is the
 * real peer and everything before it is attacker-controlled text.
 *
 * Taking `[0]` is the obvious-looking choice and was what this codebase did in three
 * places. It hands the attacker the key: one random header value per request and every
 * request lands in a fresh bucket, so a limit never triggers and an audit row records
 * whatever address was asked for. Read the LAST hop.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");

  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);

    if (hops.length > 0) {
      return hops[hops.length - 1];
    }
  }

  // Caddy always sets X-Forwarded-For, so this is the direct-connection case: a request
  // that reached the app without passing the proxy. Treat every such request as one
  // shared bucket rather than as unlimited.
  return "direct";
}
