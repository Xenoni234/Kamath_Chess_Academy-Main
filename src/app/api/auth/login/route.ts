import { addDays } from "date-fns";
import { NextRequest, NextResponse } from "next/server";
import { comparePassword, signAccessToken, signRefreshToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { clientIp, consume, exceeded, reset } from "@/lib/http/rateLimit";
import { loginSchema } from "@/lib/validations";

/**
 * This route is the most expensive unauthenticated thing in the application and it used to
 * be completely unmetered. A friendly attack on 10 Oct 2026 took the whole platform down
 * with it — live games, clocks, dashboards, everything — and the mechanism is worth
 * recording, because none of the obvious guesses were the cause.
 *
 * `comparePassword` is `bcryptjs` at cost factor 12. bcryptjs is the pure-JavaScript
 * implementation, so that work happens ON THE MAIN EVENT LOOP. Measured: 197 ms per
 * compare on an M4, during which a 10 ms timer fired twice instead of twenty — the loop is
 * available about 10% of the time. The production vCPU is slower again. So each attempt
 * freezes every page render, every API response and every Socket.io frame for roughly half
 * a second, and single-digit requests per second is enough to stop the site. There is one
 * Node process and no clustering, so the second core cannot absorb any of it.
 *
 * Then the database: a successful login takes a connection for the lookup and TWO MORE in
 * parallel for the session and audit writes, out of a pool of 10. Under the flood the pool
 * emptied, and every other query in the app — every page, every dashboard — waited the
 * full `connectionTimeoutMillis` of 10 s and then failed with "timeout exceeded when
 * trying to connect". That is why an attack on one route read as a total outage.
 *
 * So the budget below is spent BEFORE the body is parsed, before the lookup, and before
 * the hash. Anything that reaches bcrypt has already been paid for.
 *
 * Per address, every attempt counts — including SUCCESSFUL ones. The attack used valid
 * credentials, so a limiter that forgave success would have done nothing. 30 in 5 minutes
 * is generous enough for a shared connection at the academy and still caps this route at
 * about 5% of one core.
 *
 * Per account, only FAILURES count and a success clears the counter, so a legitimate
 * student is never locked out by their own typing while a password-guessing run against
 * one account is stopped at 10 tries regardless of how many addresses it comes from.
 */
const MAX_PER_IP = 30;
const IP_WINDOW_MS = 5 * 60_000;

const MAX_FAILURES_PER_ACCOUNT = 10;
const ACCOUNT_WINDOW_MS = 15 * 60_000;

function tooMany(retryAfterSeconds: number) {
  // A deliberately vague message. "Too many attempts for THIS ACCOUNT" would confirm the
  // account exists, which is the one thing an unauthenticated caller must not learn here.
  return NextResponse.json(
    {
      success: false,
      message: "Too many sign-in attempts. Please wait a few minutes and try again.",
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

export async function POST(request: NextRequest) {
  try {
    const ip = clientIp(request);
    const byIp = consume(`login:ip:${ip}`, MAX_PER_IP, IP_WINDOW_MS);

    if (byIp.limited) {
      return tooMany(byIp.retryAfterSeconds);
    }

    const body = await request.json();
    const result = loginSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { identifier, password } = result.data;

    // Keyed on what was typed, lowercased, so "Ravi" and "ravi" share one budget. It is
    // not resolved to a user id first — that would need the lookup this is meant to
    // prevent, and an account-guessing run never has a real id anyway.
    const accountKey = `login:account:${identifier.toLowerCase()}`;
    const byAccount = exceeded(accountKey, MAX_FAILURES_PER_ACCOUNT);

    if (byAccount.limited) {
      return tooMany(byAccount.retryAfterSeconds);
    }

    const user = await db.user.findFirst({
      where: {
        OR: [{ email: identifier.toLowerCase() }, { username: identifier }],
        isActive: true,
      },
      // Only these fields are used below; without a select the whole row crosses
      // the wire on every login attempt.
      select: { id: true, username: true, email: true, role: true, passwordHash: true },
    });

    if (!user || !(await comparePassword(password, user.passwordHash))) {
      consume(accountKey, MAX_FAILURES_PER_ACCOUNT, ACCOUNT_WINDOW_MS);
      return NextResponse.json({ success: false, message: "Invalid credentials." }, { status: 401 });
    }

    // Signing in correctly clears the account's failure budget, so a student who mistyped
    // four times and then got it right starts clean rather than carrying a near-lockout
    // around for the next quarter of an hour. The per-address budget is deliberately NOT
    // cleared: the attack that motivated all this used valid credentials.
    reset(accountKey);

    const tokenPayload = { userId: user.id, username: user.username, role: user.role };
    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);
    const expiresAt = addDays(new Date(), 7);

    const userAgent = request.headers.get("user-agent");
    // The observed peer, not the claimed one. This value goes into `UserSession` and the
    // audit log, so taking the client-supplied first hop meant an attacker chose what got
    // recorded about them — and the audit log is the evidence trail for the next incident.
    const ipAddress = ip;

    // Independent writes — running them one after the other cost two full round
    // trips to Tokyo instead of one.
    await Promise.all([
      db.userSession.create({
        data: { userId: user.id, refreshToken, expiresAt, userAgent, ipAddress },
      }),
      db.auditLog.create({
        data: { userId: user.id, action: "USER_LOGGED_IN", userAgent, ipAddress },
      }),
    ]);

    const response = NextResponse.json({
      success: true,
      user: { id: user.id, username: user.username, email: user.email, role: user.role },
    });

    response.cookies.set("kca_access_token", accessToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 15,
    });
    response.cookies.set("kca_refresh_token", refreshToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });

    return response;
  } catch (error) {
    console.error("Login failed:", error);
    return NextResponse.json({ success: false, message: "Login failed." }, { status: 500 });
  }
}
