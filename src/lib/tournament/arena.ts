import type { Pairing } from "./types";

export type ArenaPlayer = {
  userId: string;
  score: number;
  /** Their most recent opponent, to avoid an immediate rematch when possible. */
  lastOpponent?: string;
};

/**
 * Arena pairing: continuously pair the currently-free players, preferring
 * similar scores (sorted) and avoiding an immediate rematch. Returns the pairs
 * plus any leftover (odd one out) who waits for the next free player.
 */
export function arenaPairings(freePlayers: ArenaPlayer[]): { pairings: Pairing[]; unpaired: string[] } {
  const sorted = [...freePlayers].sort((a, b) => b.score - a.score);
  const used = new Set<string>();
  const pairings: Pairing[] = [];

  for (let i = 0; i < sorted.length; i += 1) {
    const p = sorted[i];
    if (used.has(p.userId)) continue;

    let opponent = sorted
      .slice(i + 1)
      .find((q) => !used.has(q.userId) && q.userId !== p.lastOpponent && p.userId !== q.lastOpponent);
    if (!opponent) {
      opponent = sorted.slice(i + 1).find((q) => !used.has(q.userId));
    }
    if (!opponent) continue;

    used.add(p.userId);
    used.add(opponent.userId);
    const pWhite = pairings.length % 2 === 0;
    pairings.push(pWhite ? { whiteId: p.userId, blackId: opponent.userId } : { whiteId: opponent.userId, blackId: p.userId });
  }

  const unpaired = sorted.filter((p) => !used.has(p.userId)).map((p) => p.userId);
  return { pairings, unpaired };
}
