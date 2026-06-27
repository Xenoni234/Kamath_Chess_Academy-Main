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

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!pathname.startsWith("/dashboard")) {
    return NextResponse.next();
  }

  const token = request.cookies.get("kca_access_token")?.value;
  const secret = process.env.JWT_SECRET;

  if (!token || !secret) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const payload = await verifyHs256(token, secret);

  if (!payload?.role) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const matchedRoute = Object.keys(roleRoutes).find((route) => pathname.startsWith(route));

  if (matchedRoute && !roleRoutes[matchedRoute].includes(payload.role)) {
    return NextResponse.redirect(new URL(`/dashboard/${payload.role.toLowerCase()}`, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
