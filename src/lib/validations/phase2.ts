import { z } from "zod";

/**
 * Explain one move.
 *
 * The client sends only the position and the move — deliberately NO evaluations
 * and no move lists. It used to send those, and a caller that computed them
 * wrongly (an eval belonging to a different position, an empty alternatives
 * list, "best move" set to the played move) produced confident, wrong coaching
 * with nothing able to detect it. The server now derives every number from the
 * position itself, so a client cannot mis-state the analysis.
 */
export const explainMoveSchema = z.object({
  /** Position the move is played FROM. Legality is checked in the route. */
  fen: z.string().min(10).max(120),
  /** The move to explain, UCI (e2e4, e7e8q). */
  playedUci: z
    .string()
    .trim()
    .regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/i, "Expected a UCI move like e2e4"),
});

const LICHESS_SPEEDS = ["ultraBullet", "bullet", "blitz", "rapid", "classical", "correspondence"] as const;
// Bands accepted by the explorer API; each runs up to the next one.
const LICHESS_RATING_BANDS = ["0", "1000", "1200", "1400", "1600", "1800", "2000", "2200", "2500"] as const;

export const openingQuerySchema = z.object({
  // A FEN is six space-separated fields; the cap keeps an oversized string from
  // reaching the Lichess API or the md5 cache key.
  fen: z.string().min(10).max(120),
  speeds: z
    .string()
    .optional()
    .transform((value) => value?.split(",").filter(Boolean))
    .pipe(z.array(z.enum(LICHESS_SPEEDS)).min(1).max(6).optional()),
  ratings: z
    .string()
    .optional()
    .transform((value) => value?.split(",").filter(Boolean))
    .pipe(z.array(z.enum(LICHESS_RATING_BANDS)).min(1).max(9).optional()),
});

export const otpSendSchema = z.object({
  email: z.string().email(),
  purpose: z.enum(["register", "login"]),
});

export const otpVerifySchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6),
  purpose: z.enum(["register", "login"]),
});

export const puzzleAttemptSchema = z.object({
  solved: z.boolean(),
  timeTakenMs: z.number().positive(),
});

export const reportGenerateSchema = z
  .object({
    lichessId: z.string().optional(),
    chesscomId: z.string().optional(),
  })
  .refine((d) => d.lichessId || d.chesscomId, {
    message: "At least one platform ID is required",
  });
