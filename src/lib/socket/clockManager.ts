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

  if (moverId === gameState.white) {
    return {
      whiteTimeMs: Math.max(0, gameState.whiteTimeMs - elapsedMs) + gameState.incrementMs,
      blackTimeMs: gameState.blackTimeMs,
    };
  }

  return {
    whiteTimeMs: gameState.whiteTimeMs,
    blackTimeMs: Math.max(0, gameState.blackTimeMs - elapsedMs) + gameState.incrementMs,
  };
}
