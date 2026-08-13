/**
 * Track F3 — transposition graph in Neo4j.
 *
 * The opponent's repertoire Trie is a *tree* keyed by move-order, so the same
 * position reached two ways is two nodes. Loaded into Neo4j and MERGE-d on a
 * position key (the first four FEN fields — placement, side, castling, en
 * passant — dropping the move counters that differ between transpositions), the
 * tree collapses into a DAG. A position reachable from the start by two or more
 * distinct move-orders is a transposition, which lets us steer a game into a
 * position the opponent is weak at while sidestepping the move-order they know.
 *
 * Neo4j is opt-in: without NEO4J_* env vars `graphEnabled()` is false and the
 * stage is skipped, so the rest of the dossier still generates.
 */
import neo4j, { type Driver } from "neo4j-driver";
import { START_FEN } from "@/lib/engine/analysis";
import type { TranspositionLine, TrieNode, WeaknessPosition } from "@/lib/second/types";

let driver: Driver | null = null;

export function graphEnabled(): boolean {
  return Boolean(process.env.NEO4J_URI && process.env.NEO4J_USER && process.env.NEO4J_PASSWORD);
}

function getDriver(): Driver | null {
  if (!graphEnabled()) return null;
  if (!driver) {
    driver = neo4j.driver(
      process.env.NEO4J_URI!,
      neo4j.auth.basic(process.env.NEO4J_USER!, process.env.NEO4J_PASSWORD!),
    );
  }
  return driver;
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

/** Transposition key: piece placement + side + castling + en passant (no counters). */
function positionKey(fen: string): string {
  return fen.split(/\s+/).slice(0, 4).join(" ");
}

type GraphEdge = {
  fromKey: string;
  toKey: string;
  fromFen: string;
  toFen: string;
  san: string;
  weight: number;
  fromPly: number;
  toPly: number;
};

function collectEdges(root: TrieNode): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const walk = (node: TrieNode) => {
    for (const child of Object.values(node.children)) {
      edges.push({
        fromKey: positionKey(node.fen),
        toKey: positionKey(child.fen),
        fromFen: node.fen,
        toFen: child.fen,
        san: child.san,
        weight: child.weightedCount,
        fromPly: node.ply,
        toPly: child.ply,
      });
      walk(child);
    }
  };
  walk(root);
  return edges;
}

/** Load (replacing) one profile's repertoire DAG into Neo4j. */
async function loadTrieToGraph(profileId: string, root: TrieNode): Promise<void> {
  const d = getDriver();
  if (!d) return;
  const edges = collectEdges(root);
  const session = d.session();
  try {
    await session.run(`MATCH (p:Position {profileId:$pid}) DETACH DELETE p`, { pid: profileId });
    await session.run(
      `MERGE (r:Position {profileId:$pid, key:$key}) SET r.ply = 0, r.fen = $fen`,
      { pid: profileId, key: positionKey(START_FEN), fen: START_FEN },
    );

    const CHUNK = 500;
    for (let i = 0; i < edges.length; i += CHUNK) {
      await session.run(
        `UNWIND $edges AS e
         MERGE (a:Position {profileId:$pid, key:e.fromKey})
           ON CREATE SET a.ply = e.fromPly, a.fen = e.fromFen
         MERGE (b:Position {profileId:$pid, key:e.toKey})
           ON CREATE SET b.ply = e.toPly, b.fen = e.toFen
         MERGE (a)-[r:MOVE {profileId:$pid, san:e.san}]->(b)
           ON CREATE SET r.weight = e.weight
           ON MATCH SET r.weight = r.weight + e.weight`,
        { pid: profileId, edges: edges.slice(i, i + CHUNK) },
      );
    }
  } finally {
    await session.close();
  }
}

/** For each weak target, find distinct move-orders that reach it (transpositions). */
async function findTranspositions(
  profileId: string,
  weaknesses: WeaknessPosition[],
): Promise<TranspositionLine[]> {
  const d = getDriver();
  if (!d) return [];
  const session = d.session();
  const out: TranspositionLine[] = [];
  try {
    for (const w of weaknesses.slice(0, 6)) {
      const res = await session.run(
        `MATCH p = (root:Position {profileId:$pid, ply:0})-[:MOVE*1..24]->(t:Position {profileId:$pid, key:$key})
         WITH [r IN relationships(p) | r.san] AS moves,
              reduce(s = 0.0, r IN relationships(p) | s + coalesce(r.weight, 0.0)) AS tw
         RETURN moves, tw ORDER BY tw DESC LIMIT 8`,
        { pid: profileId, key: positionKey(w.fen) },
      );
      const paths = res.records
        .map((r) => ({ moves: r.get("moves") as string[], tw: Number(r.get("tw")) }))
        .filter((p) => Array.isArray(p.moves) && p.moves.length > 0);
      if (paths.length < 2) continue;

      const main = paths[0];
      const alt = paths.find((p) => p.moves[0] !== main.moves[0]) ?? paths[1];
      if (!alt) continue;

      out.push({
        targetFen: w.fen,
        mainLine: main.moves,
        bypass: alt.moves,
        note: `Same position as their usual ${main.moves.slice(0, 4).join(" ")}… can be reached via ${alt.moves.slice(0, 4).join(" ")}…, sidestepping the move-order they know best.`,
      });
    }
    return out;
  } finally {
    await session.close();
  }
}

/**
 * Full transposition stage: load the DAG and query bypass lines for the weak
 * targets. Any Neo4j failure degrades to an empty result with graphUsed=false —
 * the dossier is still produced without the transposition section.
 */
export async function runGraphStage(
  profileId: string,
  root: TrieNode,
  weaknesses: WeaknessPosition[],
): Promise<{ transpositions: TranspositionLine[]; graphUsed: boolean }> {
  if (!graphEnabled()) return { transpositions: [], graphUsed: false };
  try {
    await loadTrieToGraph(profileId, root);
    const transpositions = await findTranspositions(profileId, weaknesses);
    return { transpositions, graphUsed: true };
  } catch (error) {
    console.error("[second] Neo4j transposition stage failed:", error);
    return { transpositions: [], graphUsed: false };
  }
}
