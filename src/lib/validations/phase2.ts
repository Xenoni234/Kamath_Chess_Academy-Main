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
