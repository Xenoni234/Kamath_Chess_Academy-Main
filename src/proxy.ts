import { NextRequest, NextResponse } from "next/server";

type JwtPayload = {
  role?: string;
  exp?: number;
};

const roleRoutes: Record<string, string[]> = {
  "/dashboard/student": ["STUDENT"],
  "/dashboard/parent": ["PARENT"],
  "/dashboard/coach": ["COACH"],
  "/dashboard/hr": ["HR", "HEAD"],
  "/dashboard/head": ["HEAD"],
  "/dashboard/admin": ["HR", "HEAD"],
  // Narrower than the rest of /dashboard/admin. Fees are the head's alone, and
  // the segment matcher takes the LONGEST match, so this is not shadowed by the
  // line above.
  "/dashboard/admin/payments": ["HEAD"],
  "/dashboard/schedule": ["COACH", "HR", "HEAD"],
  "/dashboard/children": ["PARENT", "HR", "HEAD"],
  "/dashboard/roster": ["COACH", "HR", "HEAD"],
  // Who may OPEN a student's page. Whether they may see THAT student is decided
  // by `canViewStudent` in /api/students/[id]/overview — this only keeps the
  // shell away from roles it could never be useful to.
  "/dashboard/student-detail": ["COACH", "HR", "HEAD", "PARENT"],
};

/**
 * Where each role belongs. A lookup rather than interpolating the role into a
 * path — a redirect target should never be built from a token-derived string.
 */
const HOME_FOR_ROLE: Record<string, string> = {
  STUDENT: "/dashboard/student",
  PARENT: "/dashboard/parent",
  COACH: "/dashboard/coach",
  HR: "/dashboard/hr",
  HEAD: "/dashboard/head",
};

function base64UrlToBytes(input: string) {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

async function verifyHs256(token: string, secret: string): Promise<JwtPayload | null> {
  const [header, payload, signature] = token.split(".");

  if (!header || !payload || !signature) {
    return null;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlToBytes(signature),
    new TextEncoder().encode(`${header}.${payload}`)
  );

  if (!valid) {
    return null;
  }

  const decoded = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as JwtPayload;

  if (decoded.exp && decoded.exp * 1000 < Date.now()) {
    return null;
  }

  return decoded;
}

/** Send them to sign in, remembering where they were headed. */
function loginWithReturn(request: NextRequest, pathname: string) {
  const url = new URL("/login", request.url);
  // Only ever a same-site path, so this cannot become an open redirect.
  if (pathname.startsWith("/dashboard")) url.searchParams.set("next", pathname);
  return url;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!pathname.startsWith("/dashboard")) {
    return NextResponse.next();
  }

  const token = request.cookies.get("kca_access_token")?.value;
  const secret = process.env.JWT_SECRET;

  if (!token || !secret) {
    return NextResponse.redirect(loginWithReturn(request, pathname));
  }

  const payload = await verifyHs256(token, secret);

  if (!payload?.role) {
    return NextResponse.redirect(loginWithReturn(request, pathname));
  }

  // Match on whole path SEGMENTS, not a raw string prefix.
  //
  // `pathname.startsWith(route)` made "/dashboard/student-detail/abc" match the
  // "/dashboard/student" rule, so the STUDENT-only gate fired and every coach,
  // parent and head who clicked a student was bounced to their own dashboard.
  // The page was fine; the router never let them reach it.
  //
  // Longest match wins, so a more specific rule is never shadowed by a shorter
  // one that happens to share a prefix.
  const matchedRoute = Object.keys(roleRoutes)
    .filter((route) => pathname === route || pathname.startsWith(`${route}/`))
    .sort((a, b) => b.length - a.length)[0];

  if (matchedRoute && !roleRoutes[matchedRoute].includes(payload.role)) {
    const home = HOME_FOR_ROLE[payload.role] ?? "/login";
    return NextResponse.redirect(new URL(home, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
