/**
 * Track F2 — the opponent's opening repertoire as a SAN-keyed Trie.
 *
 * Each game the opponent played on the given colour is walked into a shared
 * tree; every node carries the recency-weighted number of games that reached it
 * and the opponent's weighted score from there. This is the backbone the
 * weakness, transposition and repertoire stages all read from.
 */
import { START_FEN } from "@/lib/engine/analysis";
import type { TrieNode, WeightedGame } from "@/lib/second/types";

/** Opening theory rarely diverges past here; keep the tree bounded. */
export const MAX_TRIE_PLY = 24;

function addResult(node: TrieNode, game: WeightedGame): void {
  if (game.won) node.wWins += game.weight;
  else if (game.drawn) node.wDraws += game.weight;
  else node.wLosses += game.weight;
}

/**
 * Build the repertoire Trie for the games where the opponent played `color`.
 * Results are stored from the opponent's point of view (wWins = they won).
 */
export function buildTrie(games: WeightedGame[], color: "w" | "b"): TrieNode {
  const root: TrieNode = {
    fen: START_FEN,
    san: "",
    ply: 0,
    mover: null,
    weightedCount: 0,
    wWins: 0,
    wDraws: 0,
    wLosses: 0,
    children: {},
  };

  for (const game of games) {
    if (game.color !== color) continue;
    root.weightedCount += game.weight;
    addResult(root, game);

    let cursor = root;
    const limit = Math.min(game.nodes.length, MAX_TRIE_PLY);
    for (let i = 0; i < limit; i += 1) {
      const node = game.nodes[i];
      let child = cursor.children[node.san];
      if (!child) {
        child = {
          fen: node.fen,
          san: node.san,
          ply: node.ply,
          mover: node.mover,
          weightedCount: 0,
          wWins: 0,
          wDraws: 0,
          wLosses: 0,
          children: {},
        };
        cursor.children[node.san] = child;
      }
      child.weightedCount += game.weight;
      addResult(child, game);
      cursor = child;
    }
  }

  return root;
}

/** Depth-first walk of every node under (and including) `root`. */
export function flattenTrie(root: TrieNode): TrieNode[] {
  const out: TrieNode[] = [];
  const stack: TrieNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    out.push(node);
    for (const child of Object.values(node.children)) stack.push(child);
  }
  return out;
}

export type TrieSummaryLine = { line: string[]; weightedCount: number; scorePct: number };

function opponentScorePct(node: TrieNode): number {
  if (node.weightedCount <= 0) return 0;
  return Math.round(((node.wWins + node.wDraws * 0.5) / node.weightedCount) * 1000) / 10;
}

/**
 * The opponent's most-played lines, as distinct SAN move-orders. Greedily takes
 * the heaviest nodes from ply `minPly` on, skipping any line that is a prefix of
 * (or prefixed by) one already chosen, so parents and children don't both show.
 */
export function trieSummaryLines(root: TrieNode, limit = 12, minPly = 6): TrieSummaryLine[] {
  const candidates: { line: string[]; node: TrieNode }[] = [];

  const walk = (node: TrieNode, path: string[]) => {
    if (node.ply >= minPly) candidates.push({ line: path, node });
    for (const child of Object.values(node.children)) walk(child, [...path, child.san]);
  };
  walk(root, []);

  candidates.sort((a, b) => b.node.weightedCount - a.node.weightedCount);

  const chosen: TrieSummaryLine[] = [];
  const isPrefix = (a: string[], b: string[]) => a.every((san, i) => b[i] === san);

  for (const c of candidates) {
    if (chosen.length >= limit) break;
    const clashes = chosen.some(
      (ch) => isPrefix(ch.line, c.line) || isPrefix(c.line, ch.line),
    );
    if (clashes) continue;
    chosen.push({
      line: c.line,
      weightedCount: Math.round(c.node.weightedCount * 10) / 10,
      scorePct: opponentScorePct(c.node),
    });
  }

  return chosen;
}
