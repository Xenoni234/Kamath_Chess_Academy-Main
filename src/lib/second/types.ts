/**
 * Shared types for the Digital Second AI (Phase 4).
 *
 * The profiling pipeline (ingest -> Trie -> weakness -> transpositions ->
 * novelty -> repertoire) passes these structures between stages, and the final
 * `ProfileArtifact` is what gets persisted on `OpponentProfile.artifact` and
 * fed to Claude to author the repertoire.
 */
import type { PositionNode } from "@/lib/engine/analysis";

export type OpponentSource = "LICHESS" | "CHESSCOM";
export type Color = "white" | "black";

/** One online account. A dossier merges 1..5 of them into a single opponent. */
export type AccountRef = { handle: string; source: OpponentSource };

/**
 * How a game ended, normalised across both sites.
 *
 * The vocabulary cannot be symmetric and should not pretend to be: Lichess
 * collapses draw-by-agreement, repetition, fifty-move and insufficient material
 * into a single `draw`, while Chess.com distinguishes all four. Every game
 * therefore also carries `terminationRaw` verbatim, so no fidelity is lost and a
 * later stage can re-map without a re-ingest.
 */
export type Termination =
  | "mate"
  | "resign"
  | "flagged"
  | "stalemate"
  | "draw-agreed"
  | "repetition"
  | "insufficient"
  | "fifty-move"
  | "flag-vs-insufficient"
  | "draw-unspecified"
  | "abandoned"
  | "aborted"
  | "rules-infraction"
  | "unknown";

/** Speed bucket, normalised — Chess.com's `daily` maps onto `correspondence`. */
export type SpeedBucket =
  | "ultraBullet"
  | "bullet"
  | "blitz"
  | "rapid"
  | "classical"
  | "correspondence"
  | "unknown";

/**
 * The real time control, not the speed bucket.
 *
 * Every numeric field is nullable and `null` means UNKNOWN. Defaulting an
 * unknown increment to 0 is what makes think time silently wrong, so it is not
 * done anywhere: an unknown increment must propagate as an unknown think time.
 */
export type TimeControl = {
  /** Base clock in seconds. Null for correspondence/daily, or when unstated. */
  initialSec: number | null;
  /** Increment in seconds. Null when the source did not state it. */
  incrementSec: number | null;
  /** Seconds per move — correspondence/daily only (Chess.com "1/259200"). */
  perMoveSec: number | null;
  speed: SpeedBucket;
  /** Verbatim source value ("600+5", "1/86400") for auditing. */
  raw: string | null;
};

/**
 * A single ingested game, weighted by recency.
 *
 * In-memory only — never persisted — so this can change shape freely. Only
 * `ProfileArtifact` needs backwards-compatible optionality.
 */
export type WeightedGame = {
  /** Which colour the opponent played in this game. */
  color: "w" | "b";
  nodes: PositionNode[];
  openingName: string;
  eco: string | null;
  won: boolean;
  drawn: boolean;
  /**
   * `${source}:${gameId}` — the dedup key when several accounts are merged.
   * Source is part of the key because a Lichess id and a Chess.com uuid live in
   * different namespaces and could otherwise collide.
   */
  gameKey: string;
  gameId: string;
  /** Which of the profiled accounts contributed this game. */
  account: AccountRef;
  termination: Termination;
  /** Lichess `status` / the losing side's Chess.com `result`, verbatim. */
  terminationRaw: string | null;
  timeControl: TimeControl;
  rated: boolean | null;
  /** The profiled player's rating in this game. */
  playerRating: number | null;
  opponentRating: number | null;
  opponentHandle: string | null;
  /**
   * Canonical timestamp for recency: the END of the game. A game is only
   * evidence once it has finished, and a correspondence game begun in March and
   * finished in August is August evidence.
   */
  playedAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  /** 0..1 recency weight (halves every HALF_LIFE_DAYS). */
  weight: number;
  /**
   * Per-ply remaining clock in centiseconds, when the source provides it.
   * Dropped entirely when it does not line up with the move list — a short or
   * long array would otherwise shift every think time in the game by a constant
   * ply offset, silently.
   */
  clocks?: number[];
};

/** Per-account provenance, so a merged dossier can be audited rather than trusted. */
export type ArtifactAccount = {
  handle: string;
  source: OpponentSource;
  /** Returned by the API. */
  gamesFetched: number;
  /** Survived dedup and the total budget — what actually shaped the dossier. */
  gamesUsed: number;
  /** ISO. */
  oldestPlayedAt: string | null;
  newestPlayedAt: string | null;
  /**
   * Mean recency weight of this account's contribution — the number that tells
   * you an account is stale. 1.0 = current, ~0.13 = three half-lives old.
   */
  meanWeight: number;
  status: AccountIngestStatus;
};

/**
 * `not-found` = the site returned 404; `rate-limited` = 429 after a retry.
 * These are kept apart from `error` because an empty result and a refused
 * request look identical downstream, and only one of them means "no games".
 */
export type AccountIngestStatus = "ok" | "not-found" | "rate-limited" | "error";

/** Where the games went. Every drop is counted so the arithmetic can be checked. */
export type IngestDiagnostics = {
  totalFetched: number;
  duplicatesDropped: number;
  /** Games between two profiled accounts — the same human on both sides. */
  selfPlayDropped: number;
  noTimestampDropped: number;
  budgetTrimmed: number;
  clocksDiscardedMisaligned: number;
  /** True when the run used the reduced inline-fallback budget. */
  budgetReduced?: boolean;
};

/** One node of the opponent's opening repertoire Trie (per colour). */
export type TrieNode = {
  /** FEN reached after `san` was played (start position for the root). */
  fen: string;
  /** SAN that leads into this node from its parent ("" at the root). */
  san: string;
  /** Ply depth from the root (0 = root). */
  ply: number;
  /** Whose move produced this node — matches the opponent when it's their choice. */
  mover: "w" | "b" | null;
  weightedCount: number;
  wWins: number;
  wDraws: number;
  wLosses: number;
  children: Record<string, TrieNode>;
};

/** A position where the opponent is demonstrably weak. */
export type WeaknessPosition = {
  fen: string;
  /** SAN move-order from the start that reaches `fen`. */
  line: string[];
  /** The move the opponent actually plays most from here. */
  theirMove: string;
  /** 0..100 accuracy of their move vs the engine's best. */
  accuracy: number;
  /** Average seconds they spend on this decision (from clocks), if known. */
  avgClockSpent: number | null;
  weightedFrequency: number;
  /** Composite: low accuracy amplified by long think time. Higher = weaker. */
  weaknessScore: number;
};

/** A move-order that reaches a target position while dodging the opponent's main line. */
export type TranspositionLine = {
  targetFen: string;
  /** The bypass SAN move-order. */
  bypass: string[];
  /** The opponent's most-frequent move-order to the same FEN (their "prep"). */
  mainLine: string[];
  note: string;
  /**
   * `bypass` played out to a usable depth — their own book while it lasts, then
   * Stockfish. Absent on dossiers generated before extension existed.
   */
  extended?: string[];
  /** Ply within `extended` where the opponent leaves their book. */
  outOfBookAtPly?: number;
};

/** An engine-strong, human-rare move at a target position. */
export type Novelty = {
  fen: string;
  /** SAN move-order to `fen`. */
  line: string[];
  /** The novelty move in SAN. */
  move: string;
  /** Engine eval in centipawns (from the side-to-move's view). */
  evalCp: number | null;
  /** Share of human games that played this move (0..1); null if no explorer data. */
  explorerShare: number | null;
};

/** One line of the repertoire we recommend playing against the opponent. */
export type RepertoireLine = {
  /** SAN move-order of the recommended line. */
  moves: string[];
  /** Why this line targets the opponent (weakness/novelty/transposition it exploits). */
  rationale: string;
  tag: "weakness" | "novelty" | "transposition" | "mainline";
  /**
   * Ply at which the opponent leaves their own book — after this point their
   * moves are the engine's guess, not something they have actually played.
   * Undefined when they stayed in book for the whole line, or when the line was
   * never extended.
   */
  outOfBookAtPly?: number;
  /** Engine evaluation at the end of the extended line, centipawns from White. */
  evalCp?: number | null;
};

/** The full profiling result persisted on OpponentProfile.artifact. */
export type ProfileArtifact = {
  /** The primary account — always `accounts[0]` when `accounts` is present. */
  handle: string;
  source: OpponentSource;
  /**
   * Every merged account, with provenance. Absent on single-account dossiers
   * generated before multi-account support — treat that as "one account,
   * details unknown" rather than assuming anything.
   */
  accounts?: ArtifactAccount[];
  /** Where the games went. Absent on dossiers generated before this existed. */
  ingest?: IngestDiagnostics;
  /**
   * The newest game across all accounts, ISO — the point recency decays from.
   * Absent on older dossiers, where each account decayed from its own newest
   * game and a long-abandoned account could weigh as much as a live one.
   */
  recencyReferenceAt?: string;
  /**
   * Which games the think-time figures were measured on. Absent on dossiers
   * generated before think time was increment-corrected — on those, every
   * `avgClockSpent` is understated by the increment and is not comparable.
   */
  clockBasis?: {
    initialSec: number | null;
    gamesUsed: number;
    gamesExcluded: number;
  };
  colorToPlay: Color;
  gamesAnalyzed: number;
  /**
   * `handle`/`source` are absent on older dossiers, where entries were keyed by
   * format alone and two accounts playing the same format collided silently.
   */
  ratingSummary: {
    format: string;
    rating: number | null;
    handle?: string;
    source?: OpponentSource;
  }[];
  /** Compact top of the opponent's repertoire, deepest-weighted lines first. */
  trieSummary: { line: string[]; weightedCount: number; scorePct: number }[];
  weaknesses: WeaknessPosition[];
  transpositions: TranspositionLine[];
  novelties: Novelty[];
  /** True when Neo4j was available and the transposition pass ran. */
  graphUsed: boolean;
  /**
   * Why the pass did not run, when `graphUsed` is false. Absent on dossiers
   * generated before this was recorded — treat that as "unknown" rather than
   * assuming a cause.
   */
  graphSkipReason?: GraphSkipReason;
};

/** `not-configured` = no NEO4J_* env vars; `failed` = the stage threw. */
export type GraphSkipReason = "not-configured" | "failed";

/**
 * BullMQ payload for a profiling run.
 *
 * `handle`/`source` stay REQUIRED even though `accounts` supersedes them. These
 * payloads are JSON sitting in Redis, so a deploy that lands while jobs are
 * queued hands the worker an old-shape object. Readers use
 * `data.accounts ?? [{ handle, source }]`, which is the one line that keeps
 * that from being an incident.
 */
export type ProfileJobData = {
  profileId: string;
  requestedById: string;
  /** Absent on jobs enqueued before multi-account support. */
  accounts?: AccountRef[];
  /** The primary account. */
  handle: string;
  source: OpponentSource;
  colorToPlay: Color;
  fideId?: string;
};
