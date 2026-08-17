/**
 * Tactical motif detection.
 *
 * Given a position and a move, decide which tactical ideas that move exploits.
 * Built from first principles on chess.js — there is no motif data in any of the
 * feeds we ingest, and none of the engine output says *why* a move is good.
 *
 * The whole point of this module is that its accuracy is MEASURED, not asserted:
 * `scripts/validateMotifs.ts` runs it against the ~500k Lichess puzzles in the
 * `Puzzle` table and scores it against Lichess's own `themes[]` labels. Motif
 * names below deliberately match Lichess theme keys so that comparison is direct.
 * Nothing here reaches a dossier until it clears a stated precision bar.
 */
import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";

export const MOTIFS = [
  "fork",
  "pin",
  "skewer",
  "discoveredAttack",
  "hangingPiece",
  "backRankMate",
] as const;

export type Motif = (typeof MOTIFS)[number];

/**
 * Measured precision against Lichess's own labels — 1500 positive and 1500
 * negative puzzles per motif, via `scripts/validateMotifs.ts`.
 *
 * These are quoted to the user in the dossier, so they are load-bearing facts,
 * not documentation. **Re-run the harness and update them whenever the detector
 * changes**, or the dossier will be citing a number that no longer holds.
 */
export const MOTIF_PRECISION: Record<Motif, number> = {
  fork: 0.903,
  skewer: 0.908,
  discoveredAttack: 0.897,
  hangingPiece: 0.968,
  backRankMate: 0.916,
  pin: 0.769,
};

/**
 * The motifs allowed into a dossier.
 *
 * `pin` is deliberately absent: it measured 76.9% precision, so roughly a
 * quarter of the positions it flagged were not pins. A tournament plan built on
 * "they miss pins" that is wrong a quarter of the time is worse than not
 * mentioning pins at all — reporting five motifs honestly beats six
 * speculatively. Restoring it means improving the detector and re-measuring,
 * not lowering the bar.
 */
export const SHIPPABLE_MOTIFS: readonly Motif[] = [
  "fork",
  "skewer",
  "discoveredAttack",
  "hangingPiece",
  "backRankMate",
] as const;

/** Human-facing names for the motifs we actually report. */
export const MOTIF_LABEL: Record<Motif, string> = {
  fork: "Forks",
  pin: "Pins",
  skewer: "Skewers",
  discoveredAttack: "Discovered attacks",
  hangingPiece: "Loose pieces",
  backRankMate: "Back-rank mates",
};

/** Centipawn-ish values, only ever used for comparisons. King is effectively infinite. */
const VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

const ROOK_DIRS = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
] as const;
const BISHOP_DIRS = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

const FILES = "abcdefgh";

function toCoords(square: Square): [number, number] {
  return [FILES.indexOf(square[0]), Number(square[1]) - 1];
}

function toSquare(file: number, rank: number): Square | null {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return `${FILES[file]}${rank + 1}` as Square;
}

function opposite(color: Color): Color {
  return color === "w" ? "b" : "w";
}

/** Directions a slider of this type travels, or null when it is not a slider. */
function sliderDirs(type: PieceSymbol): readonly (readonly [number, number])[] | null {
  if (type === "r") return ROOK_DIRS;
  if (type === "b") return BISHOP_DIRS;
  if (type === "q") return [...ROOK_DIRS, ...BISHOP_DIRS];
  return null;
}

type Occupant = { square: Square; type: PieceSymbol; color: Color };

/**
 * The first two occupied squares along a ray from `from`.
 *
 * Pins and skewers are both "two enemy pieces in a line behind each other", and
 * which one it is depends only on their relative value — so both fall out of
 * this one primitive.
 */
function rayScan(
  chess: Chess,
  from: Square,
  dir: readonly [number, number],
): { first: Occupant | null; second: Occupant | null } {
  const [df, dr] = dir;
  let [file, rank] = toCoords(from);
  let first: Occupant | null = null;

  for (;;) {
    file += df;
    rank += dr;
    const square = toSquare(file, rank);
    if (!square) break;
    const piece = chess.get(square);
    if (!piece) continue;
    const occupant: Occupant = { square, type: piece.type, color: piece.color };
    if (!first) {
      first = occupant;
      continue;
    }
    return { first, second: occupant };
  }
  return { first, second: null };
}

/** Squares of `by`-coloured pieces attacking `square`. */
function attackersOf(chess: Chess, square: Square, by: Color): Square[] {
  try {
    return chess.attackers(square, by);
  } catch {
    return [];
  }
}

/**
 * Is this piece hanging — attacked and not defended at all?
 *
 * Deliberately the strict reading (zero defenders) rather than a full static
 * exchange evaluation. A real SEE is the more correct test, but it is also
 * where a hand-rolled detector most easily goes subtly wrong; the harness will
 * say whether the simpler rule is good enough, and the number it reports is
 * honest either way.
 */
function isHanging(chess: Chess, square: Square, owner: Color): boolean {
  const attacked = attackersOf(chess, square, opposite(owner)).length > 0;
  if (!attacked) return false;
  return attackersOf(chess, square, owner).length === 0;
}

/**
 * Is this piece absolutely pinned — is its own king directly behind it on the
 * ray from an enemy slider? Relative pins can be broken; absolute ones cannot,
 * and only the latter genuinely immobilise the piece.
 */
function isPinnedAbsolutely(chess: Chess, square: Square, owner: Color): boolean {
  const piece = chess.get(square);
  if (!piece || piece.color !== owner || piece.type === "k") return false;

  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell || cell.color === owner) continue;
      const dirs = sliderDirs(cell.type);
      if (!dirs) continue;
      for (const dir of dirs) {
        const { first, second } = rayScan(chess, cell.square, dir);
        if (first?.square === square && second?.type === "k" && second.color === owner) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Motifs created by `moveUci` played from `fen`.
 *
 * Returns an empty set when the move is illegal in that position rather than
 * throwing — a caller scanning thousands of real games will hit the occasional
 * unparseable line, and one bad row must not abort the batch.
 */
export function detectMotifs(fen: string, moveUci: string): Set<Motif> {
  const found = new Set<Motif>();
  if (moveUci.length < 4) return found;

  const from = moveUci.slice(0, 2) as Square;
  const to = moveUci.slice(2, 4) as Square;
  const promotion = moveUci.length > 4 ? moveUci[4] : undefined;

  const before = new Chess();
  try {
    before.load(fen);
  } catch {
    return found;
  }

  const movingPiece = before.get(from);
  if (!movingPiece) return found;
  const mover = movingPiece.color;
  const enemy = opposite(mover);

  const captured = before.get(to);
  const capturedWasHanging = captured ? isHanging(before, to, enemy) : false;

  // Which enemy pieces were already attacked by our sliders before the move —
  // used to tell a genuinely *discovered* attack from one that already existed.
  const attackedBefore = new Set<Square>();
  for (const row of before.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== mover) continue;
      const dirs = sliderDirs(cell.type);
      if (!dirs) continue;
      for (const dir of dirs) {
        const { first } = rayScan(before, cell.square, dir);
        if (first && first.color === enemy) attackedBefore.add(first.square);
      }
    }
  }

  const after = new Chess();
  after.load(fen);
  try {
    after.move({ from, to, promotion });
  } catch {
    return found;
  }

  const landed = after.get(to);
  if (!landed) return found;

  // --- Back-rank mate ------------------------------------------------------
  // Checkmate delivered by a heavy piece along the defender's own first rank.
  if (after.isCheckmate()) {
    const backRank = enemy === "w" ? "1" : "8";
    if ((landed.type === "r" || landed.type === "q") && to[1] === backRank) {
      found.add("backRankMate");
    }
  }

  // --- Fork ----------------------------------------------------------------
  // The piece that just moved now attacks two or more enemy pieces worth
  // taking. "Worth taking" excludes undefended pawns: counting those made this
  // fire on ~30% of puzzles Lichess does not call a fork, because almost any
  // developing move attacks a couple of loose pawns.
  const forkTargets: Occupant[] = [];
  for (const row of after.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== enemy) continue;
      if (!attackersOf(after, cell.square, mover).includes(to)) continue;
      const undefended = attackersOf(after, cell.square, enemy).length === 0;
      const worthIt =
        cell.type === "k" ||
        VALUE[cell.type] > VALUE[landed.type] ||
        (undefended && cell.type !== "p");
      if (worthIt) forkTargets.push({ square: cell.square, type: cell.type, color: cell.color });
    }
  }
  // A forking piece that can simply be taken is a blunder, not a fork — unless
  // one of the targets is the king, which forces them to deal with the check
  // first.
  const forkerSafe =
    attackersOf(after, to, enemy).length === 0 ||
    attackersOf(after, to, mover).length > 0 ||
    forkTargets.some((t) => t.type === "k");
  if (forkTargets.length >= 2 && forkerSafe) found.add("fork");

  // --- Pin and skewer ------------------------------------------------------
  // Both are "two enemy pieces on one ray from a friendly slider". Which one it
  // is depends only on which of the pair is more valuable: the shielded piece
  // behind (pin) or in front (skewer).
  //
  // Scanning from EVERY friendly slider, not just the one that moved: Lichess
  // labels a puzzle `pin` when the solution exploits a pin as much as when it
  // creates one, and only checking the moved piece missed nearly half of them.
  const pinnedEnemies = new Set<Square>();
  for (const row of after.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== mover) continue;
      const sliderDirections = sliderDirs(cell.type);
      if (!sliderDirections) continue;
      for (const dir of sliderDirections) {
        const { first, second } = rayScan(after, cell.square, dir);
        if (!first || !second) continue;
        if (first.color !== enemy || second.color !== enemy) continue;
        if (VALUE[second.type] > VALUE[first.type]) {
          // Only an ABSOLUTE pin (king behind) or a clearly costly one is worth
          // the name. Counting every "slightly better piece behind" pairing put
          // precision at 74%.
          const meaningful = second.type === "k" || VALUE[second.type] - VALUE[first.type] >= 2;
          if (meaningful) {
            pinnedEnemies.add(first.square);
            // Only the moved piece establishing the line counts as creating it;
            // an exploited pre-existing pin is handled just below.
            if (cell.square === to) found.add("pin");
          }
        } else if (VALUE[first.type] > VALUE[second.type] && cell.square === to) {
          // A skewer is a heavy piece forced to step aside — the front piece
          // must be genuinely valuable AND actually under threat, or this is
          // just two enemy pieces that happen to line up.
          const frontIsHeavy = VALUE[first.type] >= 5;
          const frontAttacked = attackersOf(after, first.square, mover).includes(to);
          if (frontIsHeavy && frontAttacked && second.type !== "p") found.add("skewer");
        }
      }
    }
  }
  // Exploiting a pin: the move piles onto a piece that cannot legally run.
  // `isPinnedAbsolutely` rather than "pinned-ish", because a relative pin can be
  // broken and the piece is not really stuck.
  if (!found.has("pin")) {
    for (const square of pinnedEnemies) {
      if (!attackersOf(after, square, mover).includes(to)) continue;
      const piece = after.get(square);
      if (piece && isPinnedAbsolutely(after, square, enemy)) {
        found.add("pin");
        break;
      }
    }
  }

  // --- Discovered attack ---------------------------------------------------
  // Vacating `from` opened a line for a friendly slider onto an enemy piece
  // that it was not already hitting. The moved piece itself is excluded, or
  // every ordinary developing move would qualify.
  for (const row of after.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== mover || cell.square === to) continue;
      const sliderDirections = sliderDirs(cell.type);
      if (!sliderDirections) continue;
      for (const dir of sliderDirections) {
        const { first } = rayScan(after, cell.square, dir);
        if (!first || first.color !== enemy) continue;
        if (attackedBefore.has(first.square)) continue;
        // Only counts if the line runs through the square we just left.
        const [sf, sr] = toCoords(cell.square);
        const [ff, fr] = toCoords(from);
        const alongRay =
          (ff - sf) * dir[1] === (fr - sr) * dir[0] &&
          Math.sign(ff - sf) === Math.sign(dir[0]) &&
          Math.sign(fr - sr) === Math.sign(dir[1]);
        if (alongRay) {
          found.add("discoveredAttack");
          break;
        }
      }
    }
  }

  // --- Hanging piece -------------------------------------------------------
  // Taking a genuinely loose piece. Pawns are excluded and the capture must not
  // simply lose the capturing piece for less: without those two conditions this
  // fired on ~74% of puzzles Lichess does not label `hangingPiece`, because
  // "captured something undefended" describes an enormous share of all moves.
  if (capturedWasHanging && captured && captured.type !== "p") {
    // Strictly free material: nothing can even recapture. Allowing "recapturable
    // but a favourable trade" kept this at 68% precision, because an even trade
    // of an undefended piece describes a large share of all captures and is not
    // what Lichess means by `hangingPiece`.
    if (attackersOf(after, to, enemy).length === 0) found.add("hangingPiece");
  }

  return found;
}

/**
 * Motifs judged only on the first solution move — see detectMotifsAcrossLine.
 *
 * `hangingPiece` measured 67.9% precision when unioned across the line and
 * 97.4% restricted to the first move: a loose piece gets taken *somewhere* in
 * most multi-move solutions, so the union was describing lines rather than the
 * puzzle. `pin` was tried here too and got worse (76% → 74% precision, 69% →
 * 37% recall), because exploiting a pin genuinely does happen deeper in a line.
 */
const FIRST_MOVE_ONLY: ReadonlySet<Motif> = new Set<Motif>(["hangingPiece"]);

/**
 * Motifs across a whole solution line, unioned.
 *
 * Lichess themes describe a puzzle as a whole, and the tactic frequently lands
 * on the second or third solution move rather than the first — scoring only the
 * first move understates recall badly. `moves` is the raw Lichess UCI sequence,
 * whose FIRST entry is the opponent's setup move; the solution is every move at
 * an odd index.
 */
export function detectMotifsAcrossLine(fen: string, moves: string[]): Set<Motif> {
  const union = new Set<Motif>();
  const board = new Chess();
  try {
    board.load(fen);
  } catch {
    return union;
  }

  for (let i = 0; i < moves.length; i += 1) {
    const uci = moves[i];
    if (i % 2 === 1) {
      const isFirstSolutionMove = i === 1;
      for (const motif of detectMotifs(board.fen(), uci)) {
        // Some motifs describe the position the puzzle STARTS from rather than
        // anything the line later reaches. Unioning those across a 4-move
        // solution fires on nearly everything — a loose piece gets taken
        // somewhere in most lines — so they only count on the first move.
        if (!isFirstSolutionMove && FIRST_MOVE_ONLY.has(motif)) continue;
        union.add(motif);
      }
    }
    try {
      board.move({
        from: uci.slice(0, 2) as Square,
        to: uci.slice(2, 4) as Square,
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
    } catch {
      break;
    }
  }
  return union;
}
