/**
 * Shared types for the Digital Second AI (Phase 4).
 *
 * The profiling pipeline (ingest -> Trie -> weakness -> transpositions ->
 * novelty -> repertoire) passes these structures between stages, and the final
 * `ProfileArtifact` is what gets persisted on `OpponentProfile.artifact` and
 * fed to Claude to author the repertoire.
 */
import type { PositionNode } from "@/lib/engine/analysis";

/**
 * Where an opponent's games came from.
 *
 * LICHESS / CHESSCOM are online handles fetched from a public API. MANUAL is a
 * batch of games pasted by the user (no API, no handle -- see pgnImport.ts).
 * BROADCAST is an OTB game pulled from a Lichess broadcast via a FIDE ID.
 *
 * The last two carry no real "handle": a player name has spaces and commas that
 * `accountSchema.handle` rejects, so they use a synthetic handle (the FIDE ID,
 * or `pasted-{n}`) and put the readable name in `displayName`.
 */
export type OpponentSource = "LICHESS" | "CHESSCOM" | "MANUAL" | "BROADCAST";

/** Sources the user can type a handle for in the account picker. The other two
 *  arrive through paste / FIDE lookup, not a dropdown. */
export type OnlineSource = "LICHESS" | "CHESSCOM";

/** The one place a source becomes a human label. Keyed by the full union so
 *  adding a source is a compile error here rather than a silent "Chess.com". */
export const SOURCE_LABEL: Record<OpponentSource, string> = {
  LICHESS: "Lichess",
  CHESSCOM: "Chess.com",
  MANUAL: "Pasted",
  BROADCAST: "OTB (broadcast)",
};

export type Color = "white" | "black";

/** One online account. A dossier merges 1..5 of them into a single opponent. */
export type AccountRef = { handle: string; source: OpponentSource; displayName?: string | null };

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
  /**
   * True when `incrementSec` was DERIVED from the clock series rather than
   * stated by the source. OTB broadcast PGN carries no [TimeControl] tag at
   * all, so without inference every think-time figure for an over-the-board
   * game would be null. An inferred control is still evidence — but the dossier
   * has to say which it is.
   */
  incrementInferred?: boolean;
};

/**
 * Compact, cacheable per-game record — no expanded FEN tree, no recency weight.
 *
 * Lives here rather than in ingest.ts because three sources now produce it:
 * the two online APIs, pasted PGN, and OTB broadcasts.
 */
export type RawGame = {
  color: "w" | "b";
  san: string;
  openingName: string;
  eco: string | null;
  won: boolean;
  drawn: boolean;
  gameId: string;
  termination: Termination;
  terminationRaw: string | null;
  tc: TimeControl;
  rated: boolean | null;
  playerRating: number | null;
  opponentRating: number | null;
  opponentHandle: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  clocks?: (number | null)[];
};

export type RawIngest = {
  games: RawGame[];
  ratingSummary: { format: string; rating: number | null }[];
  status: AccountIngestStatus;
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
  /**
   * Position tree, truncated to HYDRATE_MAX_PLY — deep enough for the
   * repertoire stages and a fraction of the memory of a full game at 1000
   * games.
   */
  nodes: PositionNode[];
  /**
   * The complete move list, untruncated. Kept as a string because it costs
   * ~200 bytes against ~12 KB for a full node tree: stages that genuinely need
   * whole games (the tactical scan) rebuild only the games they scan.
   */
  san: string;
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
  clocks?: (number | null)[];
};

/** Per-account provenance, so a merged dossier can be audited rather than trusted. */
export type ArtifactAccount = {
  handle: string;
  source: OpponentSource;
  /** Human name for MANUAL/BROADCAST sources whose handle is synthetic
   *  (a FIDE ID or `pasted-{n}`). Null for online accounts, where the handle
   *  is already the readable name. */
  displayName?: string | null;
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
  /** How OTB (FIDE/broadcast) discovery went. Null when no FIDE id was given;
   *  a message when discovery degraded (scrape found nothing, no broadcasts,
   *  etc.) so the dossier can state what it could not see rather than imply the
   *  player has no OTB games. */
  otbNote?: string | null;
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
  /** Absent on dossiers generated before tactical profiling existed. */
  tactical?: TacticalProfile;
  /** Absent on dossiers generated before behavioural profiling existed. */
  behaviour?: BehaviouralProfile;
  /** How their play changed over time. Absent on older dossiers. */
  evolution?: EvolutionProfile;
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
 * How often the opponent finds or misses one tactical motif.
 *
 * `missRate` is always accompanied by its denominator and interval. A rate
 * without them invites "they miss 50% of forks" when the truth was one miss out
 * of two — the interval makes that unusable-looking, which is correct.
 */
export type MotifStat = {
  motif: string;
  /** Positions where the engine's best move executed this motif. */
  opportunities: number;
  /** They played a move executing it. */
  found: number;
  /** They had it, played something else, and lost material or position by it. */
  missed: number;
  missRate: number;
  /** 95% Wilson bounds on `missRate`. */
  missRateLow: number;
  missRateHigh: number;
  /**
   * Measured precision of the detector for this motif, against Lichess's own
   * puzzle labels. Shown to the user so the claim carries its own error bar.
   */
  detectorPrecision: number;
};

/**
 * One measured slice of their play. `n` is always present because a bucketed
 * accuracy without its sample size is the easiest way for a dossier to mislead.
 */
export type BehaviourBucket = {
  label: string;
  n: number;
  /** Mean accuracy 0..100, with a 95% interval on the mean. */
  accuracy: number;
  accuracyLow: number;
  accuracyHigh: number;
  /** Share of moves in this bucket losing 300cp or more. */
  blunderRate: number;
};

/**
 * Behavioural profile. Absent on dossiers generated before it existed.
 *
 * Every field is a correlation over their own games, not a psychological claim —
 * the UI is responsible for saying so.
 */
export type BehaviouralProfile = {
  gamesScanned: number;
  movesGraded: number;
  /** Buckets below this many samples must render as insufficient evidence. */
  minSamples: number;
  /** False when too few games carried usable clocks; hides the clock sections. */
  clockDataAvailable: boolean;
  /** Accuracy as a fraction of their base clock runs down. */
  timePressure: BehaviourBucket[];
  /** Accuracy after an unusually long think, versus a normal one. */
  longThink: BehaviourBucket[];
  /** Accuracy in the game following a win versus following a loss. */
  tilt: BehaviourBucket[];
  /** Accuracy by position character, worst first. */
  structures: BehaviourBucket[];
  lossesAnalyzed: number;
  /** OTB losses left out of the termination breakdown below. Broadcast PGN has
   *  no [Termination] tag, so how those games ended is genuinely unknown — the
   *  section reports the count and excludes them rather than inventing resigns. */
  otbLossesExcluded: number;
  /** How their losses end. Empty when there were too few losses to be useful. */
  terminations: {
    termination: string;
    label: string;
    count: number;
    share: number;
    shareLow: number;
    shareHigh: number;
  }[];
};

/** One time-era slice of the opponent's play. Only eras clearing the sample
 *  thresholds appear. See evolution.ts. */
export type EvolutionEra = {
  /** Calendar year, e.g. "2024". */
  label: string;
  games: number;
  moves: number;
  /** (wins + draws/2) / games, as a percentage. Their result, not their accuracy. */
  scorePct: number | null;
  /** Mean of their own rating in that era's games, when known (OTB carries it). */
  meanRating: number | null;
  accuracy: number;
  accuracyLow: number;
  accuracyHigh: number;
  blunderRate: number;
  blunderRateLow: number;
  blunderRateHigh: number;
};

/** A trend stated ONLY because the two eras' intervals do not overlap. */
export type EvolutionTrend = {
  metric: "accuracy" | "blunderRate" | "rating";
  direction: "up" | "down";
  from: string;
  to: string;
  detail: string;
};

/** An opening family that entered or left the repertoire between the first and
 *  last qualifying era. */
export type RepertoireShift = {
  color: "w" | "b";
  opening: string;
  fromShare: number;
  toShare: number;
  direction: "adopted" | "abandoned";
};

/** How the opponent has changed with time. Absent on dossiers built before this
 *  existed, or when there is only one qualifying era (`insufficient`). */
export type EvolutionProfile = {
  eras: EvolutionEra[];
  trends: EvolutionTrend[];
  repertoireShifts: RepertoireShift[];
  /** True when fewer than two eras cleared the thresholds — no trend possible. */
  insufficient: boolean;
};

/** Absent on dossiers generated before tactical profiling existed. */
export type TacticalProfile = {
  gamesScanned: number;
  /** Their own moves the engine actually graded. */
  positionsScanned: number;
  motifs: MotifStat[];
  /** Motifs below this many opportunities are reported as insufficient data. */
  minOpportunities: number;
};

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
