import { z } from "zod";

export const explainMoveSchema = z.object({
  fen: z.string().min(10),
  playerMoveSan: z.string(),
  bestMoveSan: z.string(),
  evaluation: z.number(),
  topMoves: z.array(
    z.object({
      san: z.string(),
      evaluation: z.number(),
      continuation: z.string(),
    })
  ),
  isGoodMove: z.boolean(),
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
