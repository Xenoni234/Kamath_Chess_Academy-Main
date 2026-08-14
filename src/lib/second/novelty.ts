/**
 * Track F4 — novelty mining.
 *
 * A playable novelty is a move the *engine* rates among the best in a position
 * but *humans* almost never play. Played against the opponent, it drops them out
 * of book immediately while keeping an objectively sound position. We take the
 * engine's top moves (MultiPV) at each target position and cross them against
 * the Lichess Opening Explorer's human move shares; an engine-near-best move
 * with a tiny (or zero) human share is a novelty.
 *
 * Degrades to no novelties when the explorer is unavailable (no
 * LICHESS_API_TOKEN) — the rest of the dossier is unaffected.
 */
import { Chess } from "chess.js";
import { analyzePositionsMultiPV } from "@/lib/engine/serverEngine";
import { scoreToCentipawns } from "@/lib/engine/classify";
import { sideToMove, uciToMove } from "@/lib/engine/uci";
import { fetchExplorer } from "@/lib/second/explorer";
import type { Novelty } from "@/lib/second/types";

/** A move played in fewer than this share of human games counts as rare. */
const RARE_SHARE = 0.1;
/** Ignore rarity judgments on positions with too little human data. */
const MIN_HUMAN_GAMES = 30;
/** A candidate must be within this many centipawns of the engine's best. */
const NEAR_BEST_CP = 40;
/** ...and must not be losing for the side to move. */
const MIN_SOUND_CP = -40;
const MAX_TARGETS = 20;

export type NoveltyBudget = { depth: number; multiPv: number; threads: number; totalTimeoutMs: number };
const DEFAULT_BUDGET: NoveltyBudget = { depth: 12, multiPv: 3, threads: 1, totalTimeoutMs: 5 * 60 * 1000 };

export type NoveltyTarget = { fen: string; line: string[] };

function sanFor(fen: string, uci: string): string | null {
  try {
    const chess = new Chess(fen);
    const move = chess.move(uciToMove(uci));
    return move ? move.san : null;
  } catch {
    return null;
  }
}

export async function mineNovelties(
  targets: NoveltyTarget[],
  budget: NoveltyBudget = DEFAULT_BUDGET,
): Promise<Novelty[]> {
  const picks = targets.slice(0, MAX_TARGETS);
  if (picks.length === 0) return [];

  const multi = await analyzePositionsMultiPV(
    picks.map((t) => t.fen),
    budget,
  );

  const out: Novelty[] = [];

  for (let i = 0; i < picks.length; i += 1) {
    const moves = multi[i];
    if (!moves || moves.length === 0) continue;

    const { fen, line } = picks[i];
    const stm = sideToMove(fen);
    const stmScore = (m: { cp: number | null; mate: number | null }) => {
      const white = scoreToCentipawns(m.cp, m.mate);
      return stm === "w" ? white : -white;
    };

    const bestScore = Math.max(...moves.map(stmScore));
    const candidates = moves.filter(
      (m) => stmScore(m) >= bestScore - NEAR_BEST_CP && stmScore(m) >= MIN_SOUND_CP,
    );
    if (candidates.length === 0) continue;

    // One explorer lookup per position; skip when the explorer is unavailable.
    let explorer;
    try {
      explorer = await fetchExplorer(fen);
    } catch {
      continue;
    }
    if (!explorer.ok) continue;

    const total = explorer.data.white + explorer.data.draws + explorer.data.black;
    if (total < MIN_HUMAN_GAMES) continue;

    const shareByUci = new Map<string, number>();
    for (const m of explorer.data.moves) {
      shareByUci.set(m.uci, (m.white + m.draws + m.black) / total);
    }

    // The rarest sound candidate is the strongest surprise.
    let best: { uci: string; share: number; score: number } | null = null;
    for (const c of candidates) {
      const share = shareByUci.get(c.uci) ?? 0;
      if (share >= RARE_SHARE) continue;
      if (!best || share < best.share) best = { uci: c.uci, share, score: stmScore(c) };
    }
    if (!best) continue;

    const san = sanFor(fen, best.uci);
    if (!san) continue;

    out.push({
      fen,
      line,
      move: san,
      evalCp: Math.round(best.score),
      explorerShare: Math.round(best.share * 1000) / 1000,
    });
  }

  // Rarest first — the biggest surprises lead.
  return out.sort((a, b) => (a.explorerShare ?? 0) - (b.explorerShare ?? 0));
}
