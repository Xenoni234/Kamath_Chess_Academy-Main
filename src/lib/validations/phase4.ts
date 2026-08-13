import { z } from "zod";

/**
 * Phase 4 (Digital Second AI) request validation.
 */

/** Create an opponent-profiling run. FIDE is metadata only — games need a handle. */
export const createProfileSchema = z.object({
  handle: z.string().trim().min(1, "Enter the opponent's username").max(64),
  source: z.enum(["LICHESS", "CHESSCOM"]),
  colorToPlay: z.enum(["white", "black"]).default("white"),
  fideId: z.string().trim().max(20).optional(),
});

export type CreateProfileInput = z.infer<typeof createProfileSchema>;
