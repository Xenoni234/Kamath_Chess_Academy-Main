import fs from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { deleteProfileGraph, graphEnabled } from "@/lib/second/graph";

export const runtime = "nodejs";

/** One dossier with its artifact and latest repertoire. Owner-only. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
  try {
    const payload = verifyAccessToken(token);
    const { id } = await context.params;

    // Explicit select: `updatedAt` and the repertoire's `profileId`/`createdAt`
    // are never rendered, and `linesJson` is large enough that pulling whole
    // rows across a cross-region link is worth avoiding.
    const profile = await db.opponentProfile.findUnique({
      where: { id },
      select: {
        id: true,
        requestedById: true,
        handle: true,
        source: true,
        colorToPlay: true,
        fideId: true,
        status: true,
        gamesAnalyzed: true,
        ratingSummary: true,
        artifact: true,
        summary: true,
        createdAt: true,
        accounts: {
          select: { handle: true, source: true, position: true },
          orderBy: { position: "asc" },
        },
        repertoires: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, summary: true, linesJson: true, pdfUrl: true },
        },
      },
    });

    // "Not yours" and "not found" answer identically so the route cannot be
    // used to probe which profile ids exist.
    if (!profile || profile.requestedById !== payload.userId) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }

    const plan = profile.repertoires[0] ?? null;

    return NextResponse.json({
      success: true,
      profile: {
        id: profile.id,
        handle: profile.handle,
        source: profile.source,
        accounts: profile.accounts,
        colorToPlay: profile.colorToPlay,
        fideId: profile.fideId,
        status: profile.status,
        gamesAnalyzed: profile.gamesAnalyzed,
        ratingSummary: profile.ratingSummary,
        artifact: profile.artifact,
        summary: profile.summary,
        createdAt: profile.createdAt,
        repertoire: plan
          ? { id: plan.id, summary: plan.summary, lines: plan.linesJson, hasPdf: Boolean(plan.pdfUrl) }
          : null,
      },
    });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}

/**
 * Delete a dossier. Owner-only, and permanent.
 *
 * Three stores hold pieces of a profile and only one of them cascades:
 *   - Postgres `repertoire_plans` — cascades via the FK, nothing to do here.
 *   - Neo4j `Position` nodes — a separate database with no FK to cascade from,
 *     so they must be dropped explicitly or they leak on every delete.
 *   - The repertoire PDF on local disk — `/tmp`, so it evaporates on restart
 *     anyway, but a long-lived server would otherwise accumulate them.
 */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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
      repertoires: { select: { pdfUrl: true } },
    },
  });

  // Matches GET and regenerate: "not yours" and "not found" answer identically
  // so the route cannot be used to probe which profile ids exist.
  if (!profile || profile.requestedById !== payload.userId) {
    return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
  }

  // A running job still holds this profileId and will write an artifact, a
  // repertoire row and a Neo4j subgraph back after the delete — recreating
  // exactly what we just removed, minus the parent row. Refuse instead.
  if (profile.status === "pending" || profile.status === "processing") {
    return NextResponse.json(
      {
        success: false,
        message: "This dossier is still being generated. Wait for it to finish, then delete it.",
      },
      { status: 409 },
    );
  }

  // Neo4j first: if it fails we have not destroyed anything yet, and the user
  // still has a dossier to retry from. Doing it after the row is gone would
  // strand the subgraph with no id left to clean it up by.
  const graphCleared = graphEnabled() ? await deleteProfileGraph(profile.id) : true;

  const pdfPaths = profile.repertoires.map((plan) => plan.pdfUrl).filter((p): p is string => Boolean(p));

  await db.opponentProfile.delete({ where: { id: profile.id } });

  // Best effort, and after the row is gone: an undeletable temp file is not a
  // reason to keep the dossier alive, and /tmp is ephemeral regardless.
  await Promise.all(pdfPaths.map((p) => fs.unlink(p).catch(() => {})));

  await writeAuditLog({
    action: "second.profile.delete",
    userId: payload.userId,
    metadata: { profileId: profile.id, handle: profile.handle, source: profile.source, graphCleared },
    request,
  });

  return NextResponse.json({
    success: true,
    // Surfaced rather than swallowed: the dossier is gone either way, but a
    // stranded subgraph is worth knowing about.
    graphCleared,
  });
}
