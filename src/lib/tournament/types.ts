/** A single game pairing for a round, or a bye. */
export type Pairing = { whiteId: string; blackId: string } | { byeId: string };

export function isBye(p: Pairing): p is { byeId: string } {
  return "byeId" in p;
}

/** Points: win = 1, draw = 0.5, loss = 0, bye = 1 (standard chess scoring). */
export const POINTS = { win: 1, draw: 0.5, loss: 0, bye: 1 } as const;
