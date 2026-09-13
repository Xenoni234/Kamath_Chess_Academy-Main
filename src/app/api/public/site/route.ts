import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const revalidate = 300;

/**
 * Everything the public homepage needs that comes from the database: the headline stats,
 * the "Our Champions" cards, and the coaching team.
 *
 * Unauthenticated, so the select is the privacy boundary — the same rule as
 * `/api/public/tournaments`. Photo BYTES are never included here: the list carries only
 * `hasPhoto`, and the image itself comes from its own route. Embedding a dozen headshots
 * as base64 would make the homepage payload megabytes for no benefit.
 *
 * The stats used to be hardcoded "500+ Students / 50+ Coaches / 10,000+ Games Played /
 * 15+ Tournaments" on a platform with nine accounts. Real counts are smaller and true, and
 * they grow on their own as people arrive — which is the point.
 */
export async function GET() {
  try {
    const [students, coaches, games, tournaments, achievements, team] = await Promise.all([
      db.user.count({ where: { role: "STUDENT", isActive: true } }),
      // Counted from the published team, not from staff accounts: the number under
      // "Coaches" on the homepage should match the faces directly below it.
      db.siteCoach.count({ where: { published: true } }),
      db.game.count(),
      db.tournament.count(),
      db.siteAchievement.findMany({
        where: { published: true },
        orderBy: [{ displayOrder: "asc" }, { achievedOn: "desc" }],
        // No cap. A marquee scrolls whatever it is given, and how many champions to
        // show is the academy owner's decision rather than a constant in here.
        select: { id: true, name: true, achievement: true, achievedOn: true, photoType: true },
      }),
      db.siteCoach.findMany({
        where: { published: true },
        orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
        select: { id: true, name: true, title: true, bio: true, photoType: true },
      }),
    ]);

    return NextResponse.json({
      success: true,
      stats: { students, coaches, games, tournaments },
      achievements: achievements.map(({ photoType, ...rest }) => ({ ...rest, hasPhoto: Boolean(photoType) })),
      coaches: team.map(({ photoType, ...rest }) => ({ ...rest, hasPhoto: Boolean(photoType) })),
    });
  } catch (error) {
    console.error("[public/site] GET failed:", error);
    // The homepage must render even if the database is unreachable. Zeroed stats and
    // empty sections are quiet; a 500 is a broken front page.
    return NextResponse.json({
      success: true,
      stats: { students: 0, coaches: 0, games: 0, tournaments: 0 },
      achievements: [],
      coaches: [],
    });
  }
}
