import jwt from "jsonwebtoken";

/**
 * 8x8 JaaS tokens — the thing that removes the second login.
 *
 * On public `meet.jit.si` every participant is a stranger to Jitsi, so Jitsi asks them who
 * they are and (for the first person in) makes them authenticate with a Google or GitHub
 * account. A nine-year-old joining a maths-hour chess class should not be signing into
 * anything, and their coach should not be either — the platform already knows exactly who
 * both of them are.
 *
 * JaaS replaces that with a signed assertion: the SERVER says "this is Xenon, a student,
 * let them in", the meeting trusts the signature, and nobody is asked for anything. It
 * also upgrades the room from obscurity to real authentication, which is what `AGENTS.md`
 * has listed as the honest limit of the current setup.
 *
 * **Configuration is optional and the feature degrades cleanly.** Without the three env
 * vars this returns null and the class falls back to public meet.jit.si exactly as before,
 * so a missing key is a downgrade, never an outage. Set:
 *
 *   JAAS_APP_ID       the "vpaas-magic-cookie-…" AppID from the JaaS console
 *   JAAS_KID          the API key id shown next to the key you generated
 *   JAAS_PRIVATE_KEY  the RSA private key PEM for that key id
 *
 * The private key is a credential: it lives in the environment, never in source, and
 * signing happens only on the server. A token minted in the browser would let anyone mint
 * one for any room.
 */

export type JaasRole = "moderator" | "participant";

export function jaasConfigured(): boolean {
  return Boolean(process.env.JAAS_APP_ID && process.env.JAAS_KID && process.env.JAAS_PRIVATE_KEY);
}

export function jaasAppId(): string | null {
  return process.env.JAAS_APP_ID ?? null;
}

/**
 * Mint a token for one person joining one room.
 *
 * `room` is scoped to the specific room, never `*`. A wildcard token is a skeleton key for
 * every class in the academy, and it would be handed to a browser.
 */
export function mintJaasToken(params: {
  room: string;
  userId: string;
  name: string;
  email?: string | null;
  role: JaasRole;
  /** Seconds. Short by design — a class is not a session. */
  ttlSeconds?: number;
}): string | null {
  const appId = process.env.JAAS_APP_ID;
  const kid = process.env.JAAS_KID;
  const privateKey = process.env.JAAS_PRIVATE_KEY;
  if (!appId || !kid || !privateKey) return null;

  const now = Math.floor(Date.now() / 1000);
  const ttl = params.ttlSeconds ?? 3 * 60 * 60;

  return jwt.sign(
    {
      aud: "jitsi",
      iss: "chat",
      sub: appId,
      room: params.room,
      exp: now + ttl,
      nbf: now - 10,
      context: {
        user: {
          id: params.userId,
          name: params.name,
          email: params.email ?? undefined,
          // The coach moderates; students join. This is what stops a student muting
          // the class or ending the meeting for everyone.
          moderator: params.role === "moderator" ? "true" : "false",
        },
        features: {
          // Screen sharing is the point of a chess class — the coach demonstrates on a
          // board. Recording and transcription stay off: recording a class of minors is a
          // consent question, not a feature flag.
          livestreaming: "false",
          recording: "false",
          transcription: "false",
          "outbound-call": "false",
        },
      },
    },
    // `replace` so the PEM survives being stored as a single-line env var, which is how
    // it arrives from every hosting dashboard.
    privateKey.replace(/\\n/g, "\n"),
    { algorithm: "RS256", header: { kid, alg: "RS256" } },
  );
}
