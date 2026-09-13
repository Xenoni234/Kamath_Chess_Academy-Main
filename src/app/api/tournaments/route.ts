import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { createTournamentSchema } from "@/lib/validations/phase3";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
  try {
    verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  // A failure below here is a server fault, not an auth failure. Returning 401
  // for it used to log every user out on a single database blip, silently.
  try {
    // Only these fields are read below, and the listing needs an upper bound —
    // it previously fetched whole rows for every tournament ever held.
    const tournaments = await db.tournament.findMany({
      orderBy: { startsAt: "desc" },
      take: 100,
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        startsAt: true,
        _count: { select: { players: true } },
      },
    });
    return NextResponse.json({
      success: true,
      tournaments: tournaments.map((t) => ({
        id: t.id,
        title: t.title,
        type: t.type,
        status: t.status,
        startsAt: t.startsAt,
        playerCount: t._count.players,
      })),
    });
  } catch (error) {
    console.error("[tournaments] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  // A failure below here is a server fault, not an auth failure. Returning 401
  // for it used to log every user out on a single database blip, silently.
  try {
    const denied = requireRole(payload, ["HR", "HEAD"]);
    if (denied) return denied;

    const parsed = createTournamentSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const {
      title,
      description,
      type,
      startsAt,
      publicListed,
      isOffline,
      prizePool,
      formatNote,
      venue,
      entryFee,
      contactInfo,
    } = parsed.data;

    // Empty strings become null so an unfilled field is absent rather than blank — the
    // public card only renders a prize pool when one actually exists, and "" would
    // print an empty "Prize Pool:" label.
    const orNull = (value: string | undefined) => (value ? value : null);
    const tournament = await db.tournament.create({
      data: {
        title,
        description,
        type,
        startsAt: new Date(startsAt),
        status: "UPCOMING",
        publicListed: publicListed ?? false,
        isOffline: isOffline ?? false,
        prizePool: orNull(prizePool),
        formatNote: orNull(formatNote),
        venue: orNull(venue),
        entryFee: orNull(entryFee),
        contactInfo: orNull(contactInfo),
      },
    });
    return NextResponse.json({ success: true, tournament });
  } catch (error) {
    console.error("[tournaments] POST failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
