import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Serves a public site photo — a champion's or a coach's headshot.
 *
 * Separate from `/api/public/site` on purpose: that endpoint lists a dozen entries, and
 * inlining a dozen images as base64 would turn a small JSON response into megabytes on
 * every homepage load. Here each image is its own cacheable request.
 *
 * These are pictures the academy chose to publish, so they are public and cached hard.
 * `immutable` is safe because replacing a photo writes a new `updatedAt`, and the client
 * appends it to the URL — a changed photo is a different URL.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ kind: string; id: string }> },
) {
  try {
    const { kind, id } = await context.params;

    const row =
      kind === "coach"
        ? await db.siteCoach.findUnique({ where: { id }, select: { photo: true, photoType: true, published: true } })
        : kind === "achievement"
          ? await db.siteAchievement.findUnique({ where: { id }, select: { photo: true, photoType: true, published: true } })
          : null;

    // Unpublished content is not public, even if someone knows the id.
    if (!row || !row.photo || !row.published) {
      return new NextResponse(null, { status: 404 });
    }

    return new NextResponse(new Uint8Array(Buffer.from(row.photo)), {
      headers: {
        "Content-Type": row.photoType ?? "image/jpeg",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    console.error("[public/photo] GET failed:", error);
    return new NextResponse(null, { status: 404 });
  }
}
