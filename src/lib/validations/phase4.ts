import { z } from "zod";

/**
 * Phase 4 (Digital Second AI) request validation.
 */

/** Up to this many online accounts may be merged into one dossier. */
export const MAX_PROFILE_ACCOUNTS = 5;

/** Up to this many games may be pasted in one dossier. */
export const MAX_PASTED_GAMES = 15;

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
 * Preview a pasted PGN block without running a profile. Same byte cap as the
 * create route; identity fields are optional here because the preview's whole
 * job is to TELL the user when it cannot pick a side (so they add a name/FIDE id
 * or force a colour).
 */
export const pgnPreviewSchema = z.object({
  pastedPgn: z.string().min(1).max(300_000),
  playerName: z.string().trim().max(80).optional(),
  fideId: z.string().trim().max(20).regex(/^\d*$/, "A FIDE ID is digits only").optional(),
  forcedColor: z.enum(["w", "b"]).optional(),
});

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
    fideId: z
      .string()
      .trim()
      .max(20)
      .regex(/^\d*$/, "A FIDE ID is digits only")
      .optional(),
    /** Opponent's real name — used to pick their side in pasted OTB games. */
    playerName: z.string().trim().max(80).optional(),
    /** Raw PGN, up to MAX_PASTED_GAMES games. Capped in bytes here; the game
     *  count is checked in the refine below so the error is specific. */
    pastedPgn: z.string().max(300_000).optional(),
    /** When the pasted names match neither side, the UI forces which colour the
     *  opponent played, rather than dropping the games. Must reach the job, or a
     *  paste that previewed as usable would be silently discarded at ingest. */
    forcedColor: z.enum(["w", "b"]).optional(),
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

    // Pasted games must not exceed the cap, and need an identity (a name or FIDE
    // id) so we can tell which side the opponent was on.
    if (value.pastedPgn && value.pastedPgn.trim()) {
      const gameCount = (value.pastedPgn.match(/\[Event\b/gi) ?? []).length || 1;
      if (gameCount > MAX_PASTED_GAMES) {
        ctx.addIssue({
          code: "custom",
          path: ["pastedPgn"],
          message: `Paste at most ${MAX_PASTED_GAMES} games (found ${gameCount})`,
        });
      }
      if (!value.playerName?.trim() && !value.fideId?.trim() && !value.forcedColor) {
        ctx.addIssue({
          code: "custom",
          path: ["playerName"],
          message: "Add the opponent's name or FIDE ID (or set which colour they played) so we know which side is theirs",
        });
      }
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
      playerName: value.playerName,
      pastedPgn: value.pastedPgn,
      forcedColor: value.forcedColor,
    };
  });

export type CreateProfileInput = z.infer<typeof createProfileSchema>;
