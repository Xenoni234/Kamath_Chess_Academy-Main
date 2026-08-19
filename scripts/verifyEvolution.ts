/**
 * Verify style-evolution profiling — the trend-gating discipline especially.
 *
 * Evolution slices the SAME scan by era, so it needs no engine or network: this
 * harness drives profileEvolution with synthetic games and moves whose truth is
 * known, and asserts the interval gate fires only when it should.
 *
 * The one that matters: two eras with close means but realistic per-move spread
 * (88% vs 89%) must NOT be reported as a trend — that is the exact false claim
 * that would let a stronger opponent dismiss the dossier.
 *
 * Run: npx tsx scripts/verifyEvolution.ts
 */
import { profileEvolution } from "../src/lib/second/evolution";
import type { WeightedGame } from "../src/lib/second/types";
import type { GradedMove } from "../src/lib/second/scan";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function game(year: number, color: "w" | "b", opening: string, won: boolean, rating: number): WeightedGame {
  return {
    color,
    nodes: [],
    san: "",
    openingName: opening,
    eco: null,
    won,
    drawn: false,
    gameKey: Math.random().toString(),
    gameId: Math.random().toString(),
    account: { handle: "x", source: "LICHESS" },
    termination: "resign",
    terminationRaw: null,
    timeControl: { initialSec: 600, incrementSec: 0, perMoveSec: null, speed: "rapid", raw: "600" },
    rated: true,
    playerRating: rating,
    opponentRating: 1500,
    opponentHandle: "y",
    playedAt: new Date(Date.UTC(year, 5, 1)),
    startedAt: null,
    endedAt: null,
    weight: 1,
  } as WeightedGame;
}

/** Moves with a realistic spread of accuracy around a mean (real move accuracy
 *  is highly variable, which is what makes the confidence interval meaningful). */
function moves(gameIndex: number, n: number, meanAcc: number): GradedMove[] {
  const out: GradedMove[] = [];
  for (let i = 0; i < n; i += 1) {
    const acc = Math.max(0, Math.min(100, meanAcc + ((i % 5) - 2) * 15));
    out.push({
      gameIndex,
      ply: i * 2 + 1,
      fenBefore: "",
      theirUci: "",
      bestUci: "",
      cpLoss: acc < 70 ? 400 : 10,
      accuracy: acc,
      thinkCs: null,
      remainingBeforeCs: null,
    });
  }
  return out;
}

function build(spec: { year: number; color: "w" | "b"; opening: string; won: boolean; rating: number; meanAcc: number }[]) {
  const games: WeightedGame[] = [];
  const all: GradedMove[] = [];
  spec.forEach((sp, i) => {
    games.push(game(sp.year, sp.color, sp.opening, sp.won, sp.rating));
    all.push(...moves(i, 30, sp.meanAcc));
  });
  return { games, moves: all };
}

// 1. Wide gap + repertoire switch: trend fires, shift detected.
{
  const spec = [
    ...Array.from({ length: 12 }, () => ({ year: 2022, color: "b" as const, opening: "Philidor Defense: Lion", won: false, rating: 1400, meanAcc: 72 })),
    ...Array.from({ length: 12 }, () => ({ year: 2024, color: "b" as const, opening: "Caro-Kann Defense", won: true, rating: 1650, meanAcc: 90 })),
  ];
  const evo = profileEvolution(...Object.values(build(spec)) as [WeightedGame[], GradedMove[]]);
  console.log("\nScenario 1 — wide gap + repertoire switch:");
  check("two eras qualify", evo.eras.length === 2);
  check("accuracy trend up stated", evo.trends.some((t) => t.metric === "accuracy" && t.direction === "up"));
  check("blunder trend down stated", evo.trends.some((t) => t.metric === "blunderRate" && t.direction === "down"));
  check("rating trend up stated", evo.trends.some((t) => t.metric === "rating" && t.direction === "up"));
  check("Philidor abandoned", evo.repertoireShifts.some((r) => r.direction === "abandoned" && r.opening.includes("Philidor")));
  check("Caro-Kann adopted", evo.repertoireShifts.some((r) => r.direction === "adopted" && r.opening.includes("Caro-Kann")));
}

// 2. Close means (88 vs 89) with real spread: NO accuracy trend.
{
  const spec = [
    ...Array.from({ length: 12 }, () => ({ year: 2023, color: "w" as const, opening: "Italian Game", won: true, rating: 1500, meanAcc: 88 })),
    ...Array.from({ length: 12 }, () => ({ year: 2024, color: "w" as const, opening: "Italian Game", won: true, rating: 1505, meanAcc: 89 })),
  ];
  const evo = profileEvolution(...Object.values(build(spec)) as [WeightedGame[], GradedMove[]]);
  console.log("\nScenario 2 — close means, overlapping intervals:");
  check("no accuracy trend on overlapping intervals", !evo.trends.some((t) => t.metric === "accuracy"));
  check("no rating trend on a 5-point drift", !evo.trends.some((t) => t.metric === "rating"));
}

// 3. Single era: insufficient, no trend possible.
{
  const spec = Array.from({ length: 12 }, () => ({ year: 2024, color: "w" as const, opening: "Ruy Lopez", won: true, rating: 1500, meanAcc: 80 }));
  const evo = profileEvolution(...Object.values(build(spec)) as [WeightedGame[], GradedMove[]]);
  console.log("\nScenario 3 — single era:");
  check("insufficient flagged", evo.insufficient);
  check("no trends", evo.trends.length === 0);
}

// 4. Below-threshold era is dropped (6 games < MIN_ERA_GAMES).
{
  const spec = [
    ...Array.from({ length: 6 }, () => ({ year: 2021, color: "w" as const, opening: "x", won: true, rating: 1500, meanAcc: 60 })),
    ...Array.from({ length: 12 }, () => ({ year: 2024, color: "w" as const, opening: "x", won: true, rating: 1500, meanAcc: 90 })),
  ];
  const evo = profileEvolution(...Object.values(build(spec)) as [WeightedGame[], GradedMove[]]);
  console.log("\nScenario 4 — thin era dropped:");
  check("only the qualifying era remains", evo.eras.length === 1 && evo.eras[0].label === "2024");
  check("insufficient (only one era clears)", evo.insufficient);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
