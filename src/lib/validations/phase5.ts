import { z } from "zod";

/** Request to build (or fetch the cached) repertoire for a named opening. */
export const createOpeningSchema = z.object({
  opening: z.string().trim().min(2, "Type an opening name").max(80),
  colorToPlay: z.enum(["white", "black"]).default("white"),
});

export type CreateOpeningInput = z.infer<typeof createOpeningSchema>;

/** Autocomplete / disambiguation query. */
export const resolveOpeningSchema = z.object({
  q: z.string().trim().min(1).max(80),
});
