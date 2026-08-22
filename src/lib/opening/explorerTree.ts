/**
 * Build the opponent "book" for the Opening Trainer from Lichess Explorer data.
 *
 * The dossier pipeline's `extendAll` (second/extend.ts) plays a line out using a
 * `TrieNode` of the opponent's real moves. An opening trainer has no opponent, so
 * we synthesise that book from how the wider Lichess population actually plays the
 * opening: BFS from the opening position, keeping the most popular replies at each
 * node. The result is a START-rooted SAN trie identical in shape to the opponent
 * trie, so `extendAll` consumes it unchanged.
 *
 * Without LICHESS_API_TOKEN the Explorer returns 401; the book then contains only
 * the opening's defining spine and extension falls straight to the engine — still
 * a valid repertoire, just without human-popularity-weighted replies.
 */
import { buildLineFromSan, START_FEN } from "@/lib/engine/analysis";
import { fetchExplorer } from "@/lib/second/explorer";
import type { TrieNode } from "@/lib/second/types";

/** Top-N replies kept per position. 5 captures the main branches at move 2-3. */
const DEFAULT_BREADTH = 5;
/** Deepest ply (from START) the book reaches. Seeds extend past this via engine. */
const DEFAULT_MAX_PLY = 20;
/** Hard ceiling on Explorer calls per generation, so one opening can't run away. */
const DEFAULT_MAX_QUERIES = 90;
/** Positions with fewer human games than this are treated as book-ending. */
const MIN_GAMES = 20;

export type BookOptions = {
  breadth?: number;
  maxPly?: number;
  maxQueries?: number;
};

export type BookResult = {
  book: TrieNode;
  coverage: { positionsQueried: number; positionsWithData: number; hasToken: boolean };
};

function makeNode(fen: string, san: string, ply: number, mover: "w" | "b" | null): TrieNode {
  return { fen, san, ply, mover, weightedCount: 0, wWins: 0, wDraws: 0, wLosses: 0, children: {} };
}

/**
 * Build the book rooted at the START position, containing the opening's spine
 * (`rootSan`) and, from the opening position onward, the popular continuations for
 * both sides taken from the Explorer.
 */
export async function buildExplorerBook(
  rootSan: string[],
  opts: BookOptions = {},
): Promise<BookResult> {
  const breadth = opts.breadth ?? DEFAULT_BREADTH;
  const maxPly = opts.maxPly ?? DEFAULT_MAX_PLY;
  const maxQueries = opts.maxQueries ?? DEFAULT_MAX_QUERIES;
  const hasToken = Boolean(process.env.LICHESS_API_TOKEN);

  const root = makeNode(START_FEN, "", 0, null);

  // 1. Lay the opening's defining spine from START to the opening position, so a
  //    seed line (which always contains these moves) can walk into the subtree.
  const spineNodes = buildLineFromSan(rootSan);
  let cursor = root;
  for (const n of spineNodes) {
    const child = makeNode(n.fen, n.san, n.ply, n.mover);
    child.weightedCount = 1;
    cursor.children[n.san] = child;
    cursor = child;
  }

  const coverage = { positionsQueried: 0, positionsWithData: 0, hasToken };
  if (!hasToken) return { book: root, coverage };

  // 2. BFS the Explorer from the opening position. Most-popular-first so a limited
  //    query budget is spent on the lines that matter.
  type QItem = { node: TrieNode; games: number };
  const queue: QItem[] = [{ node: cursor, games: Number.MAX_SAFE_INTEGER }];

  while (queue.length > 0 && coverage.positionsQueried < maxQueries) {
    // Pop the most-played frontier node.
    queue.sort((a, b) => b.games - a.games);
    const { node } = queue.shift()!;
    if (node.ply >= maxPly) continue;

    coverage.positionsQueried++;
    const res = await fetchExplorer(node.fen);
    if (!res.ok) continue; // 401/429/etc — degrade; spine already present
    coverage.positionsWithData++;

    const moves = res.data.moves
      .map((m) => ({ ...m, total: m.white + m.draws + m.black }))
      .filter((m) => m.total >= MIN_GAMES)
      .sort((a, b) => b.total - a.total)
      .slice(0, breadth);

    const moverAfter: "w" | "b" = node.fen.split(" ")[1] === "w" ? "w" : "b";
    for (const m of moves) {
      if (node.children[m.san]) continue;
      // Reuse chess.js via buildLineFromSan for the one move to get the child FEN.
      const step = buildLineFromSan([m.san], node.fen);
      if (step.length === 0) continue;
      const childFen = step[0].fen;
      const child = makeNode(childFen, m.san, node.ply + 1, moverAfter);
      child.weightedCount = m.total;
      child.wWins = m.white;
      child.wDraws = m.draws;
      child.wLosses = m.black;
      node.children[m.san] = child;
      queue.push({ node: child, games: m.total });
    }
  }

  return { book: root, coverage };
}
