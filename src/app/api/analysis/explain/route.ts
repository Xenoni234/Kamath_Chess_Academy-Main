import { NextRequest, NextResponse } from "next/server";
import { Chess } from "chess.js";
import { verifyAccessToken } from "@/lib/auth";
import { redis } from "@/lib/redis";
import { isClaudeConfigured, streamChessMoveExplanation } from "@/lib/claude";
import { explainMoveSchema } from "@/lib/validations/phase2";
import { buildMoveFacts } from "@/lib/analysis/moveFacts";
import { analyzePositionsMultiPV } from "@/lib/engine/serverEngine";

export const runtime = "nodejs";

/** Depth for the explain search. Two short searches, on demand, per request. */
const EXPLAIN_DEPTH = 14;
/** Bound on the pair of searches so a wedged engine cannot hold the request. */
const EXPLAIN_TIMEOUT_MS = 25_000;

/**
 * Play the move and return the resulting FEN, or null when it is not legal.
 * This is also the request's validation: explaining a move that cannot be played
 * is how the old endpoint produced confident nonsense.
 */
function applyMove(fen: string, uci: string): string | null {
  try {
    const chess = new Chess(fen);
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4].toLowerCase() : undefined,
    });
    return move ? chess.fen() : null;
  } catch {
    return null;
  }
}

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

    const { fen, playedUci } = parsed.data;

    // Reject an impossible position/move before spending anything on it.
    const fenAfter = applyMove(fen, playedUci);
    if (!fenAfter) {
      return NextResponse.json(
        { success: false, message: "That move is not legal in that position." },
        { status: 400 },
      );
    }

    const key = `rate:analysis:${payload.userId}`;
    const count = await redis.incr(key);

    if (count === 1) {
      await redis.expire(key, 60);
    }

    if (count > 10) {
      return NextResponse.json({ success: false, message: "Rate limit exceeded" }, { status: 429 });
    }

    // Both searches on one engine boot: the position before the move (top-3 with
    // their variations) and the position it reached (its evaluation, plus the
    // opponent's best reply — the refutation). The "after" score is what makes
    // "this move cost you N centipawns" an honest statement rather than a guess;
    // no caller ever supplied it.
    let lines: Awaited<ReturnType<typeof analyzePositionsMultiPV>> = [];
    try {
      lines = await analyzePositionsMultiPV([fen, fenAfter], {
        multiPv: 3,
        depth: EXPLAIN_DEPTH,
        totalTimeoutMs: EXPLAIN_TIMEOUT_MS,
      });
    } catch (error) {
      // An engine failure costs the evaluation, not the explanation: the facts
      // that come from the position itself are still true and still useful.
      console.error("[explain] engine analysis failed:", error);
    }

    const before = lines[0] ?? [];
    const afterBest = lines[1]?.[0];

    const facts = buildMoveFacts({
      fenBefore: fen,
      playedUci,
      lines: before,
      after: afterBest ? { cp: afterBest.cp, mate: afterBest.mate, pv: afterBest.pv } : null,
    });
    if (!facts) {
      return NextResponse.json(
        { success: false, message: "That move is not legal in that position." },
        { status: 400 },
      );
    }

    const encoder = new TextEncoder();

    return new Response(
      new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of streamChessMoveExplanation(facts)) {
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
