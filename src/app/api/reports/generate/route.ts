import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { reportGenerateSchema } from "@/lib/validations/phase2";
import { enqueueReport } from "@/lib/queue/queues";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;

  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = verifyAccessToken(token);
    const rawBody = await request.json();
    const parsed = reportGenerateSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ success: false, message: parsed.error.issues[0].message }, { status: 400 });
    }
    const body = parsed.data;
    const user = await db.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, username: true, email: true },
    });

    if (!user) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const report = await db.gameReport.create({
      data: {
        userId: user.id,
        lichessId: body.lichessId,
        chesscomId: body.chesscomId,
        status: "pending",
      },
    });

    // Durable when QUEUE_REDIS_URL is set (survives restarts); inline fallback otherwise.
    await enqueueReport({
      reportId: report.id,
      userId: user.id,
      username: user.username,
      userEmail: user.email,
      lichessId: body.lichessId,
      chesscomId: body.chesscomId,
    });

    return NextResponse.json({ success: true, reportId: report.id });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
