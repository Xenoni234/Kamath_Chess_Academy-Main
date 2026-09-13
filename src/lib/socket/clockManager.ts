import type { GameState } from "./gameEngine.ts";

export function parseTimeControl(timeControl: string) {
  const [minutes = "0", increment = "0"] = timeControl.split("+");
  return {
    initialMs: Number.parseInt(minutes, 10) * 60_000,
    incrementMs: Number.parseInt(increment, 10) * 1_000,
  };
}

export function calculateTimeAfterMove(
  gameState: GameState,
  moverId: string,
): { whiteTimeMs: number; blackTimeMs: number } {
  const elapsedMs = Math.max(0, Date.now() - gameState.lastMoveAt);
  const before = moverId === gameState.white ? gameState.whiteTimeMs : gameState.blackTimeMs;

  // Clamp to zero BEFORE deciding, and add the increment only to a player who still had
  // time. The old form was `Math.max(0, before - elapsed) + increment`, which erased time
  // debt: a player who overran by five seconds came back with a full increment on the
  // clock, and the caller's `moverTime <= 0` flag check could never fire in any game with
  // an increment — so in 3+2 you simply could not lose on time by moving.
  const remaining = before - elapsedMs;
  const after = remaining <= 0 ? 0 : remaining + gameState.incrementMs;

  return moverId === gameState.white
    ? { whiteTimeMs: after, blackTimeMs: gameState.blackTimeMs }
    : { whiteTimeMs: gameState.whiteTimeMs, blackTimeMs: after };
}
