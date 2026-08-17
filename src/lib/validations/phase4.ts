import { z } from "zod";

/**
 * Phase 4 (Digital Second AI) request validation.
 */

/** Up to this many online accounts may be merged into one dossier. */
export const MAX_PROFILE_ACCOUNTS = 5;

/**
 * One online account.
 *
 * The handle pattern is worth enforcing here rather than discovering later: an
 * unvalidated typo currently costs a queued job, several minutes of engine
 * work, and a "no games found" failure that reads like the opponent is private.
 * Both sites restrict usernames to this character set.
 */
const accountSchema = z.object({
  handle: z
    .string()
    .trim()
    .min(2, "Usernames are at least 2 characters")
    .max(30)
    .regex(/^[a-zA-Z0-9_-]+$/, "Usernames use letters, numbers, _ and - only"),
  source: z.enum(["LICHESS", "CHESSCOM"]),
});

export type AccountInput = z.infer<typeof accountSchema>;

/**
 * Create an opponent-profiling run. FIDE is metadata only — games need a handle.
 *
 * Accepts both the multi-account form and the original single-handle form, and
 * normalises to `accounts` in a transform so the route only ever sees one shape.
 * The legacy branch is not dead code: it keeps an older client, and any queued
 * request in flight during a deploy, working.
 */
export const createProfileSchema = z
  .object({
    accounts: z.array(accountSchema).min(1).max(MAX_PROFILE_ACCOUNTS).optional(),
    handle: z.string().trim().min(1).max(64).optional(),
    source: z.enum(["LICHESS", "CHESSCOM"]).optional(),
    colorToPlay: z.enum(["white", "black"]).default("white"),
    fideId: z.string().trim().max(20).optional(),
  })
  .superRefine((value, ctx) => {
    const accounts =
      value.accounts ??
      (value.handle && value.source ? [{ handle: value.handle, source: value.source }] : null);

    if (!accounts || accounts.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["accounts"],
        message: "Add at least one Lichess or Chess.com account",
      });
      return;
    }

    // Case-insensitively, because Postgres unique indexes are case-sensitive and
    // would happily store both "Magnus" and "magnus" — which would then count
    // every one of that player's games twice in every weighted figure.
    const seen = new Set<string>();
    accounts.forEach((account, index) => {
      const key = `${account.source}:${account.handle.toLowerCase()}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["accounts", index, "handle"],
          message: "That account is already in this dossier",
        });
      }
      seen.add(key);
    });
  })
  .transform((value) => {
    const accounts =
      value.accounts ??
      (value.handle && value.source
        ? [{ handle: value.handle, source: value.source }]
        : ([] as AccountInput[]));
    return {
      accounts,
      colorToPlay: value.colorToPlay,
      fideId: value.fideId,
    };
  });

export type CreateProfileInput = z.infer<typeof createProfileSchema>;
