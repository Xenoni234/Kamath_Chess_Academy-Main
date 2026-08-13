import type { Pairing } from "./types";

const BYE = "__BYE__";

/**
 * Full round-robin schedule generated up front via the circle method: every
 * player meets every other exactly once. With an odd number of players a bye is
 * rotated through the field. Colors alternate by round + board for fairness.
 */
export function roundRobinSchedule(playerIds: string[]): Pairing[][] {
  if (playerIds.length < 2) return [];

  const arr = [...playerIds];
  if (arr.length % 2 === 1) arr.push(BYE);
  const n = arr.length;
  const rounds: Pairing[][] = [];

  for (let round = 0; round < n - 1; round += 1) {
    const pairings: Pairing[] = [];
    for (let i = 0; i < n / 2; i += 1) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a === BYE) {
        pairings.push({ byeId: b });
      } else if (b === BYE) {
        pairings.push({ byeId: a });
      } else {
        const aWhite = (round + i) % 2 === 0;
        pairings.push(aWhite ? { whiteId: a, blackId: b } : { whiteId: b, blackId: a });
      }
    }
    rounds.push(pairings);
    // Fix the first entry, rotate the rest clockwise.
    arr.splice(1, 0, arr.pop() as string);
  }

  return rounds;
}
