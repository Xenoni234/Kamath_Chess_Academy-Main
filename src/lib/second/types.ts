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

/** A single ingested game, weighted by recency. */
export type WeightedGame = {
  /** Which colour the opponent played in this game. */
  color: "w" | "b";
  nodes: PositionNode[];
  openingName: string;
  won: boolean;
  drawn: boolean;
  playedAt: Date;
  /** 0..1 recency weight (halves every HALF_LIFE_DAYS). */
  weight: number;
  /** Per-ply remaining clock in centiseconds, when the source provides it. */
  clocks?: number[];
  timeControl: string;
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
};

/** The full profiling result persisted on OpponentProfile.artifact. */
export type ProfileArtifact = {
  handle: string;
  source: OpponentSource;
  colorToPlay: Color;
  gamesAnalyzed: number;
  ratingSummary: { format: string; rating: number | null }[];
  /** Compact top of the opponent's repertoire, deepest-weighted lines first. */
  trieSummary: { line: string[]; weightedCount: number; scorePct: number }[];
  weaknesses: WeaknessPosition[];
  transpositions: TranspositionLine[];
  novelties: Novelty[];
  /** True when Neo4j was available and the transposition pass ran. */
  graphUsed: boolean;
};

/** BullMQ payload for a profiling run. */
export type ProfileJobData = {
  profileId: string;
  requestedById: string;
  handle: string;
  source: OpponentSource;
  colorToPlay: Color;
  fideId?: string;
};
