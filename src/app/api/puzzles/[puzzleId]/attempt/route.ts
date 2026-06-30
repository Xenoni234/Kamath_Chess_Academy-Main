import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { puzzleAttemptSchema } from "@/lib/validations/phase2";

export async function POST(request: NextRequest, context: { params: Promise<{ puzzleId: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;

  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = verifyAccessToken(token);
    const { puzzleId } = await context.params;
    const body = await request.json();
    const parsed = puzzleAttemptSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Invalid request payload" },
        { status: 400 }
      );
    }

    const { solved, timeTakenMs } = parsed.data;
    const puzzle = await db.puzzle.findUnique({ where: { id: puzzleId }, select: { rating: true } });

    if (!puzzle) {
      return NextResponse.json({ success: false, message: "Puzzle not found" }, { status: 404 });
    }

    const previous = await db.puzzleAttempt.findFirst({
      where: { puzzleId, userId: payload.userId },
      orderBy: { reviewedAt: "desc" },
    });
    const now = new Date();
    const previousEaseFactor = previous?.easinessFactor ?? 2.5;
    const previousInterval = previous?.intervalDays ?? 1;
    const easinessFactor = solved ? Math.max(1.3, previousEaseFactor + 0.1) : previousEaseFactor;
    const intervalDays = solved ? (previousInterval <= 1 ? 6 : Math.round(previousInterval * easinessFactor)) : 1;
    const nextReviewAt = solved
      ? new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000)
      : new Date(now.getTime() + 10 * 60 * 1000);
    const data = {
      isCorrect: solved,
      attempts: (previous?.attempts ?? 0) + 1,
      easinessFactor,
      intervalDays,
      repetition: solved ? (previous?.repetition ?? 0) + 1 : 0,
      nextReviewAt,
      reviewedAt: now,
    };

    if (previous) {
      await db.puzzleAttempt.update({ where: { id: previous.id }, data });
    } else {
      await db.puzzleAttempt.create({ data: { ...data, puzzleId, userId: payload.userId } });
    }

    return NextResponse.json({
      solved: body.solved,
      nextReviewAt,
      ratingBefore: puzzle.rating,
      ratingAfter: puzzle.rating,
    });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
