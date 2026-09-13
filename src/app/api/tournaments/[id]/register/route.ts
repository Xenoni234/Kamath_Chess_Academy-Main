import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { verifyAccessToken } from "@/lib/auth";
import { hasRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * Entry form for an over-the-board tournament.
 *
 * `GET`  — staff see every entry; a player sees only their own.
 * `POST` — enter, or update your own entry.
 *
 * Sign-in is required throughout. A public form would be collecting a child's date of
 * birth and phone number with no consent record behind it; a registered account has
 * already given the three mandatory DPDPA consents at sign-up.
 */

const registerSchema = z.object({
  fullName: z.string().trim().min(2, "Please give your full name").max(80),
  phone: z.string().trim().regex(/^[0-9+\-\s]{7,20}$/, "Please give a contact number"),
  dateOfBirth: z.string().trim().optional().or(z.literal("")),
  rating: z.string().trim().max(20).optional().or(z.literal("")),
  fideId: z.string().trim().max(20).optional().or(z.literal("")),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

function authed(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return null;
  try {
    return verifyAccessToken(token);
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const payload = authed(request);
  if (!payload) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  try {
    const { id } = await context.params;
    const isStaff = hasRole(payload.role, ["HEAD", "HR", "COACH"]);

    const registrations = await db.tournamentRegistration.findMany({
      // A player gets their own entry and nobody else's. Staff get the list they need to
      // run the event. There is no parameter that changes this — it follows from the role.
      where: { tournamentId: id, ...(isStaff ? {} : { userId: payload.userId }) },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        userId: true,
        fullName: true,
        phone: true,
        dateOfBirth: true,
        rating: true,
        fideId: true,
        notes: true,
        status: true,
        createdAt: true,
        user: { select: { username: true } },
      },
    });

    if (isStaff && registrations.length > 0) {
      // Staff reading a list of children's names, ages and phone numbers is personal-data
      // access and the DPDPA log should show it.
      await writeAuditLog({
        action: "tournament.registrations.read",
        userId: payload.userId,
        metadata: { tournamentId: id, count: registrations.length },
        request,
      });
    }

    return NextResponse.json({ success: true, isStaff, registrations });
  } catch (error) {
    console.error("[tournaments/[id]/register] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const payload = authed(request);
  if (!payload) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid request" }, { status: 400 });
  }

  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "form");
      errors[field] ??= issue.message;
    }
    return NextResponse.json({ success: false, message: "Please check the form", errors }, { status: 400 });
  }

  try {
    const { id } = await context.params;

    const tournament = await db.tournament.findUnique({
      where: { id },
      select: { id: true, status: true, title: true },
    });
    if (!tournament) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }
    // Entering an event that has already finished is never what someone meant to do.
    if (tournament.status === "FINISHED" || tournament.status === "CANCELLED") {
      return NextResponse.json(
        { success: false, message: "Entries for this tournament are closed." },
        { status: 409 },
      );
    }

    const { fullName, phone, dateOfBirth, rating, fideId, notes } = parsed.data;
    const dob = dateOfBirth ? new Date(dateOfBirth) : null;
    if (dob && Number.isNaN(dob.getTime())) {
      return NextResponse.json(
        { success: false, message: "Please check the form", errors: { dateOfBirth: "That date is not valid" } },
        { status: 400 },
      );
    }

    const data = {
      fullName,
      phone,
      dateOfBirth: dob,
      rating: rating || null,
      fideId: fideId || null,
      notes: notes || null,
    };

    // Upsert rather than create: pressing Register twice, or coming back to correct a
    // phone number, should update the entry instead of failing on the unique index.
    // `status` is deliberately absent from the update — a player editing their own
    // details must not be able to move themselves from PENDING to CONFIRMED.
    const registration = await db.tournamentRegistration.upsert({
      where: { tournamentId_userId: { tournamentId: id, userId: payload.userId } },
      create: { tournamentId: id, userId: payload.userId, ...data },
      update: data,
      select: { id: true, status: true },
    });

    await writeAuditLog({
      action: "tournament.register",
      userId: payload.userId,
      metadata: { tournamentId: id },
      request,
    });

    return NextResponse.json({ success: true, registration });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }
    console.error("[tournaments/[id]/register] POST failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
