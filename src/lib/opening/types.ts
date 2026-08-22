/**
 * Shared types for the Opening Trainer (Phase 5).
 *
 * The pipeline (resolve name -> Explorer book -> seed variations -> extend ->
 * describe -> guide -> PDF) passes these between stages. `OpeningArtifact` is what
 * gets persisted on `OpeningRepertoire.artifact`; the extended lines live on
 * `OpeningRepertoire.linesJson`, and the AI guide on `OpeningRepertoire.summary` —
 * mirroring how a dossier splits artifact / RepertoirePlan.linesJson / summary.
 */
import type { RepertoireLine } from "@/lib/second/types";

export type OpeningColor = "white" | "black";

/** One opening from the bundled dataset (see scripts/importOpenings.ts). */
export type OpeningEntry = {
  eco: string;
  name: string;
  /** SAN move-order from the start position. */
  san: string[];
  /** UCI move-order from the start position (the stable matching key). */
  uci: string[];
  /** Ply depth of the named position. */
  ply: number;
  /** Full FEN of the resulting position. */
  fen: string;
  /** 4-field FEN (placement/stm/castling/ep) — transposition key, no clocks. */
  epd: string;
};

/** A name resolved to a concrete opening line. */
export type ResolvedOpening = {
  eco: string;
  name: string;
  /** Name up to the first ":" — the opening family. */
  family: string;
  san: string[];
  uci: string[];
  fen: string;
  ply: number;
};

/** How a seed line was classified, for labels and colouring. */
export type OpeningTag = "mainline" | "variation" | "gambit" | "trap" | "critical";

/** One named variation within the generated repertoire. Parallel to `lines[i]`. */
export type OpeningVariation = {
  eco: string;
  name: string;
  /** SAN move-order to the variation's defining position (the seed, pre-extension). */
  line: string[];
  /** Total human games at the branch from the Explorer, if known. */
  popularity: number | null;
  tag: OpeningTag;
};

/** Persisted on OpeningRepertoire.artifact. `lines` are stored separately. */
export type OpeningArtifact = {
  /** Canonical display name of the opening. */
  name: string;
  eco: string | null;
  family: string;
  colorToPlay: OpeningColor;
  /** Root moves that define the opening (SAN). */
  rootMoves: string[];
  rootFen: string;
  /** Named variations, in the same order as the persisted `lines`. */
  variations: OpeningVariation[];
  /** Index into `lines`/`variations` of the engine-best line for our colour. */
  bestLineIndex: number | null;
  /** Coverage diagnostics — how much of the tree the Explorer could see. */
  explorerCoverage: { positionsQueried: number; positionsWithData: number; hasToken: boolean };
  generatedAt: string;
};

/** BullMQ payload for an opening-generation run. */
export type OpeningJobData = {
  repertoireId: string;
  /** Canonical name resolved at request time. */
  name: string;
  colorToPlay: OpeningColor;
  /** UCI root move-order (the resolved opening), so the job need not re-resolve. */
  rootUci: string[];
  /** User to notify on completion (the first requester). */
  requestedById: string;
};

/** Re-export so opening modules import lines from one place. */
export type { RepertoireLine };
