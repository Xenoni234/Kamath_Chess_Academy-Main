/**
 * Track F6 — extend recommended repertoire lines into real, playable variations.
 *
 * Every line the earlier stages produce is only a *path to* something
 * interesting: the ply where a novelty lands, where a transposition rejoins,
 * or where the opponent plays badly. They stop there, which is barely enough to
 * prepare with.
 *
 * This walks each line forward to a usable depth using a hybrid of two sources:
 *
 *   1. THEIR BOOK. While the opponent's own game trie still has a move for the
 *      position, play the one they play most. That is what they will actually
 *      do, weaknesses and all — an engine best-move here would be modelling a
 *      player who does not exist.
 *   2. THE ENGINE. For our moves, and for both sides once their book runs dry,
 *      Stockfish decides. The ply where their book ends is recorded, because
 *      that is the moment the student is on their own and the opponent is
 *      improvising.
 *
 * The engine's principal variation does the heavy lifting: one search returns a
 * whole line, so filling the tail costs a single search rather than one per
 * move.
 */
import { Chess } from "chess.js";
import { START_FEN } from "@/lib/engine/analysis";
import { ENGINE_CONCURRENCY, mapWithEngines, type PvResult } from "@/lib/engine/serverEngine";
import type { RepertoireLine, TrieNode } from "@/lib/second/types";

/** Target length in plies. 30 plies = 15 full moves for each side. */
export const TARGET_PLIES = 30;

/** Hard ceiling so a runaway PV cannot produce an unreadable wall of moves. */
const MAX_PLIES = 40;

export type ExtendBudget = {
  /** Search depth for engine-chosen moves. */
  depth: number;
  /**
   * Threads PER ENGINE. One is deliberate: at fixed depth, extra threads make a
   * single search slower (SMP widens it), so throughput comes from running many
   * narrow engines rather than one wide one.
   */
  threads: number;
  /** How many engines run in parallel. */
  concurrency: number;
  /** Give up extending after this long and keep whatever is done. */
  totalTimeoutMs: number;
};

export const DEFAULT_EXTEND_BUDGET: ExtendBudget = {
  depth: 20,
  threads: 1,
  concurrency: ENGINE_CONCURRENCY,
  totalTimeoutMs: 10 * 60 * 1000,
};

/** Walk the trie along a SAN path. Returns null as soon as the path leaves it. */
function trieNodeFor(root: TrieNode, sanPath: string[]): TrieNode | null {
  let node: TrieNode = root;
  for (const san of sanPath) {
    const next = node.children[san];
    if (!next) return null;
    node = next;
  }
  return node;
}

/** The move the opponent plays most often from here, by weighted frequency. */
function theirMostPlayed(node: TrieNode): string | null {
  const children = Object.values(node.children);
  if (children.length === 0) return null;
  return children.reduce((best, c) => (c.weightedCount > best.weightedCount ? c : best)).san;
}

/** Apply a UCI move, returning its SAN — or null if it is not legal here. */
function playUci(chess: Chess, uci: string): string | null {
  try {
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4].toLowerCase() : undefined,
    });
    return move ? move.san : null;
  } catch {
    return null;
  }
}

/** Replay a SAN line from the start. Returns null if any move fails to parse. */
function replay(moves: string[]): Chess | null {
  const chess = new Chess(START_FEN);
  for (const san of moves) {
    try {
      if (!chess.move(san)) return null;
    } catch {
      return null;
    }
  }
  return chess;
}

async function extendOne(
  line: RepertoireLine,
  trie: TrieNode,
  /** Matches the trie's `mover` encoding, not the human-facing "white"/"black". */
  theirColor: "w" | "b",
  search: (fen: string, depth: number) => Promise<PvResult>,
  depth: number,
): Promise<RepertoireLine> {
  const chess = replay(line.moves);
  // A line we cannot replay is corrupt; hand it back untouched rather than
  // guessing at what it meant.
  if (!chess) return line;

  const moves = [...line.moves];
  const theirTurn = theirColor;
  let outOfBookAtPly: number | undefined;
  let finalCp: number | null = null;

  while (moves.length < TARGET_PLIES && !chess.isGameOver()) {
    const isTheirMove = chess.turn() === theirTurn;

    if (isTheirMove && outOfBookAtPly === undefined) {
      const node = trieNodeFor(trie, moves);
      const san = node ? theirMostPlayed(node) : null;
      if (san) {
        try {
          if (chess.move(san)) {
            moves.push(san);
            continue;
          }
        } catch {
          // Trie move illegal in this position (transposed path) — fall through
          // to the engine rather than abandoning the line.
        }
      }
      // Their book ends here: from this ply on they are improvising.
      outOfBookAtPly = moves.length;
    }

    const result = await search(chess.fen(), depth);
    if (!result.pv.length) break;
    finalCp = result.cp;

    // Consume the whole principal variation. Once the opponent is out of book
    // there is nothing left to interleave, so this fills the rest of the line
    // from a single search.
    let advanced = false;
    for (const uci of result.pv) {
      if (moves.length >= MAX_PLIES) break;
      const san = playUci(chess, uci);
      if (!san) break;
      moves.push(san);
      advanced = true;

      // Still inside their book: stop after our move so their real reply gets
      // a chance to come from the trie again.
      if (outOfBookAtPly === undefined && chess.turn() === theirTurn) break;
    }
    if (!advanced) break;
  }

  return { ...line, moves, outOfBookAtPly, evalCp: finalCp };
}

/**
 * Extend recommended lines AND bare move-orders (the transposition bypasses) in
 * one pass.
 *
 * They were previously two calls, each booting its own engine — and because
 * `buildRepertoireLines` already folds the first few bypasses into the lines,
 * up to three move-orders were extended *twice*, identically. Doing both here
 * means each distinct move-order is extended exactly once and the result is
 * shared.
 *
 * Work is fanned across a pool of single-threaded engines rather than run
 * serially on one. Lines are independent, so this is close to linear speed-up;
 * see `ENGINE_CONCURRENCY` for why single-threaded engines beat one wide one.
 *
 * Nothing here can lose data: a line that fails to extend comes back at its
 * original length.
 */
export async function extendAll(
  lines: RepertoireLine[],
  moveOrders: string[][],
  trie: TrieNode,
  /** Matches the trie's `mover` encoding, not the human-facing "white"/"black". */
  theirColor: "w" | "b",
  budget: ExtendBudget = DEFAULT_EXTEND_BUDGET,
): Promise<{
  lines: RepertoireLine[];
  moveOrders: { moves: string[]; outOfBookAtPly?: number }[];
}> {
  if (lines.length === 0 && moveOrders.length === 0) {
    return { lines, moveOrders: [] };
  }

  // One work item per distinct move-order. `key` lets the two output shapes
  // share a single extension result.
  const items: RepertoireLine[] = [
    ...lines,
    ...moveOrders.map((moves) => ({ moves, rationale: "", tag: "transposition" as const })),
  ];
  const byKey = new Map<string, RepertoireLine>();
  const unique: RepertoireLine[] = [];
  for (const item of items) {
    const key = item.moves.join(" ");
    if (!byKey.has(key)) {
      byKey.set(key, item);
      unique.push(item);
    }
  }

  try {
    const extended = await mapWithEngines(
      unique,
      (line, search) => extendOne(line, trie, theirColor, search, budget.depth),
      {
        concurrency: budget.concurrency,
        threads: budget.threads,
        totalTimeoutMs: budget.totalTimeoutMs,
      },
    );

    const resultByKey = new Map<string, RepertoireLine>();
    unique.forEach((line, i) => {
      resultByKey.set(line.moves.join(" "), extended[i] ?? line);
    });

    const pick = (original: RepertoireLine) => {
      const done = resultByKey.get(original.moves.join(" "));
      // Keep the original's rationale/tag; take only the extension result.
      return done ? { ...original, ...done, rationale: original.rationale, tag: original.tag } : original;
    };

    return {
      lines: lines.map(pick),
      moveOrders: moveOrders.map((moves) => {
        const done = resultByKey.get(moves.join(" "));
        return { moves: done?.moves ?? moves, outOfBookAtPly: done?.outOfBookAtPly };
      }),
    };
  } catch (error) {
    // Extension is an enhancement — a failure must not cost the dossier the
    // short lines it already had.
    console.error("[second] repertoire extension failed:", error);
    return { lines, moveOrders: moveOrders.map((moves) => ({ moves })) };
  }
}
