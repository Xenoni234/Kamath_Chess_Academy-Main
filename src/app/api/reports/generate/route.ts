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

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  // A failure below here is a server fault, not an auth failure. Returning 401
  // for it used to log every user out on a single database blip, silently.
  try {
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

    // The only heavyweight job with no cap: each POST spawns engine analysis, an
    // LLM narrative and a Puppeteer PDF. Two in flight per user, matching the
    // dossier route — a scripted loop would otherwise run up the AI bill.
    const inFlight = await db.gameReport.count({
      where: { userId: user.id, status: { in: ["pending", "processing"] } },
    });
    if (inFlight >= 2) {
      return NextResponse.json(
        {
          success: false,
          message: "You already have two reports building. Wait for one to finish, then try again.",
        },
        { status: 429 },
      );
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
  } catch (error) {
    console.error("[reports/generate] POST failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
