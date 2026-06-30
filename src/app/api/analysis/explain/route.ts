import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { redis } from "@/lib/redis";
import { streamChessMoveExplanation, type ChessMoveExplanationParams } from "@/lib/claude";
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
    const params = parsed.data;
    const key = `rate:analysis:${payload.userId}`;
    const count = await redis.incr(key);

    if (count === 1) {
      await redis.expire(key, 60);
    }

    if (count > 10) {
      return NextResponse.json({ success: false, message: "Rate limit exceeded" }, { status: 429 });
    }

    return new Response(
      new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of streamChessMoveExplanation(params)) {
              controller.enqueue(new TextEncoder().encode(chunk));
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      }),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
