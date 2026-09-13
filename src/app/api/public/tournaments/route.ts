import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
// Public marketing content changes rarely and is hit by every homepage visitor.
export const revalidate = 300;

/**
 * Tournaments the academy is advertising publicly — the homepage's "Upcoming
 * Tournaments" section.
 *
 * **Deliberately public, and deliberately thin.** This is the one API here with no auth
 * check, so what it selects IS the privacy boundary. Venue, entry fee and contact details
 * are not in the select at all — not fetched and then hidden, not sent and then ignored by
 * the page, simply never read from the database. "Log in to see the details" is therefore
 * true rather than decorative: the bytes are not in the response for anyone to inspect.
 *
 * That distinction matters here. The previous version of this section was three hardcoded
 * tournaments with invented ₹1,00,000 prize pools, advertised on a live site to parents
 * choosing a chess academy for their child. Real data from real tournaments is the fix;
 * being careful about which parts of it are public is the other half.
 */
export async function GET() {
  try {
    const tournaments = await db.tournament.findMany({
      where: {
        publicListed: true,
        status: { in: ["UPCOMING", "ONGOING"] },
        // A finished event is not "upcoming". Its own status should say so, but an
        // organiser who forgets to close one should not leave last month's tournament
        // advertised on the front page.
        startsAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { startsAt: "asc" },
      take: 6,
      select: {
        id: true,
        title: true,
        startsAt: true,
        type: true,
        formatNote: true,
        prizePool: true,
        isOffline: true,
        // venue / entryFee / contactInfo / description are NOT selected. See above.
      },
    });

    return NextResponse.json({ success: true, tournaments });
  } catch (error) {
    console.error("[public/tournaments] GET failed:", error);
    // The homepage must render even if the database is unreachable. An empty list is a
    // quiet section; a 500 is a broken front page.
    return NextResponse.json({ success: true, tournaments: [] });
  }
}
