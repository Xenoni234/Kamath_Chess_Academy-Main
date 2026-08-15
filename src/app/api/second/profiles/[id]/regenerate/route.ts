import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { writeAuditLog } from "@/lib/audit";
import { db } from "@/lib/db";
import { enqueueProfile } from "@/lib/queue/queues";

export const runtime = "nodejs";

/**
 * Re-run an existing dossier in place.
 *
 * The artifact — including `graphUsed` — is a snapshot written once when the job
 * finished, and nothing else recomputes it. A dossier generated while Neo4j (or
 * any other optional stage) was unavailable therefore reports that state forever.
 * This re-runs the same pipeline against the same opponent and overwrites the
 * artifact, so the dossier reflects what the server can do *now*.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;

  const profile = await db.opponentProfile.findUnique({
    where: { id },
    select: {
      id: true,
      requestedById: true,
      status: true,
      handle: true,
      source: true,
      colorToPlay: true,
      fideId: true,
    },
  });

  // Matches GET: "not yours" and "not found" answer identically so the route
  // cannot be used to probe which profile ids exist.
  if (!profile || profile.requestedById !== payload.userId) {
    return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
  }

  // Re-running mid-flight would have two jobs writing the same artifact and the
  // same profileId-scoped Neo4j subgraph.
  //
  // Claiming the row and checking it must be a SINGLE statement. Reading the
  // status and then updating it is a TOCTOU race, and a real one: the button
  // takes tens of seconds to respond under load, an impatient user clicks it
  // six times, all six reads see "complete" before any write lands, and six
  // pipelines start at once. Observed live — 6×8 engines on a 10-core machine,
  // MaxListenersExceededWarning, and a 13.8s login while it thrashed.
  const claimed = await db.opponentProfile.updateMany({
    where: { id: profile.id, status: { notIn: ["pending", "processing"] } },
    data: { status: "pending" },
  });

  if (claimed.count === 0) {
    return NextResponse.json(
      { success: false, message: "This dossier is already being generated." },
      { status: 409 },
    );
  }

  await writeAuditLog({
    action: "second.profile.regenerate",
    userId: payload.userId,
    metadata: { profileId: profile.id, handle: profile.handle, source: profile.source },
    request,
  });

  await enqueueProfile({
    profileId: profile.id,
    requestedById: payload.userId,
    handle: profile.handle,
    source: profile.source,
    // Stored as a plain String column, so narrow it rather than casting.
    colorToPlay: profile.colorToPlay === "black" ? "black" : "white",
    fideId: profile.fideId || undefined,
  });

  return NextResponse.json({ success: true, status: "pending" }, { status: 202 });
}
