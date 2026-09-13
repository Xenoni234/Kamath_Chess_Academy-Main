/**
 * Does the JaaS configuration actually mint a valid token?
 *
 *   npx tsx --env-file=.env.production scripts/verifyJaas.ts
 *
 * `mintJaasToken` returns null when anything is missing, and the class room silently falls
 * back to public meet.jit.si in that case — which is the right behaviour (a downgrade, not
 * an outage) but means a broken key looks exactly like no key at all. This tells the two
 * apart before a class of children finds out.
 *
 * Prints the token's header and claims, never the private key.
 */
import { jaasConfigured, jaasAppId, mintJaasToken } from "../src/lib/media/jaas";

function decode(part: string) {
  return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
}

let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
};

console.log("1. Configuration");
check("all three env vars are present", jaasConfigured());
check("the AppID is readable", Boolean(jaasAppId()), String(jaasAppId()));

console.log("\n2. Signing");
let token: string | null = null;
try {
  token = mintJaasToken({
    room: "KCA-verification-room",
    userId: "verify-user",
    name: "Verification",
    role: "moderator",
  });
} catch (error) {
  check("the private key signs", false, String(error));
}

check("a token was produced", Boolean(token));
if (!token) {
  console.log(`\n❌ ${fail} FAILED — classes will fall back to public meet.jit.si.`);
  process.exit(1);
}

const [h, p] = token.split(".");
const header = decode(h);
const claims = decode(p);

console.log("\n3. What the token says");
check("algorithm is RS256", header.alg === "RS256", String(header.alg));
check("the key id is in the header", typeof header.kid === "string" && header.kid.includes("/"), String(header.kid));
check("audience is jitsi", claims.aud === "jitsi", String(claims.aud));
check("subject is the AppID", claims.sub === jaasAppId(), String(claims.sub));
check("scoped to ONE room, not '*'", claims.room === "KCA-verification-room", String(claims.room));
check("moderator flag set for a coach", claims.context?.user?.moderator === "true");
check("recording is off", claims.context?.features?.recording === "false");
check("not expired", claims.exp * 1000 > Date.now(), new Date(claims.exp * 1000).toISOString());

console.log(`\n${fail === 0 ? "✅ ALL PASS — JaaS is configured correctly." : `❌ ${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
