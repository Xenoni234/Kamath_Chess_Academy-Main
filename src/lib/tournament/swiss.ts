import type { Pairing } from "./types";

export type SwissPlayer = {
  userId: string;
  score: number;
  /** userIds this player has already faced. */
  opponents: string[];
  whiteCount: number;
  blackCount: number;
  hadBye: boolean;
};

function assignColors(a: SwissPlayer, b: SwissPlayer): Pairing {
  // White goes to whoever has the larger "should get white" deficit
  // (more blacks than whites so far). Ties resolved to `a`.
  const aDeficit = a.blackCount - a.whiteCount;
  const bDeficit = b.blackCount - b.whiteCount;
  return aDeficit >= bDeficit
    ? { whiteId: a.userId, blackId: b.userId }
    : { whiteId: b.userId, blackId: a.userId };
}

/**
 * Greedy Swiss pairing for one round: sort by score, then pair each unpaired
 * player with the nearest-scored unpaired player they have not yet faced
 * (falling back to a rematch only if unavoidable). Colors are balanced across
 * rounds. With an odd field the lowest-scored player who has not had a bye gets
 * the bye. Good enough for academy events; not a full max-weight matching.
 */
export function swissPairings(players: SwissPlayer[]): Pairing[] {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  const paired = new Set<string>();
  const pairings: Pairing[] = [];

  if (sorted.length % 2 === 1) {
    let bye = [...sorted].reverse().find((p) => !p.hadBye) ?? sorted[sorted.length - 1];
    paired.add(bye.userId);
    pairings.push({ byeId: bye.userId });
  }

  for (let i = 0; i < sorted.length; i += 1) {
    const p = sorted[i];
    if (paired.has(p.userId)) continue;

    let opponent = sorted
      .slice(i + 1)
      .find((q) => !paired.has(q.userId) && !p.opponents.includes(q.userId));
    if (!opponent) {
      // Everyone nearby already played — allow a rematch rather than leave unpaired.
      opponent = sorted.slice(i + 1).find((q) => !paired.has(q.userId));
    }
    if (!opponent) continue;

    paired.add(p.userId);
    paired.add(opponent.userId);
    pairings.push(assignColors(p, opponent));
  }

  return pairings;
}
