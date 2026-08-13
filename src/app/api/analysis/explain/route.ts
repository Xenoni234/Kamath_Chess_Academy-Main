import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { redis } from "@/lib/redis";
import { isClaudeConfigured, streamChessMoveExplanation } from "@/lib/claude";
import { explainMoveSchema } from "@/lib/validations/phase2";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;

  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = verifyAccessToken(token);
    const body = await request.json();
    const parsed = explainMoveSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, message: "Invalid request payload" }, { status: 400 });
    }
    // Checked before the stream opens — afterwards the status code is fixed.
    if (!isClaudeConfigured()) {
      return NextResponse.json(
        { success: false, message: "AI explanations are not configured on this server." },
        { status: 503 },
      );
    }

    const params = parsed.data;
    const key = `rate:analysis:${payload.userId}`;
    const count = await redis.incr(key);

    if (count === 1) {
      await redis.expire(key, 60);
    }

    if (count > 10) {
      return NextResponse.json({ success: false, message: "Rate limit exceeded" }, { status: 429 });
    }

    const encoder = new TextEncoder();

    return new Response(
      new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of streamChessMoveExplanation(params)) {
              // Stop pulling from Claude as soon as the reader goes away —
              // otherwise a user navigating mid-explanation keeps burning
              // tokens until the response completes.
              if (request.signal.aborted) break;
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          } catch (error) {
            if (request.signal.aborted) {
              controller.close();
              return;
            }
            console.error("Move explanation stream failed:", error);
            controller.error(error);
          }
        },
      }),
      {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          // Keeps reverse proxies from buffering the whole body before
          // forwarding, which would defeat streaming.
          "X-Accel-Buffering": "no",
        },
      },
    );
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
