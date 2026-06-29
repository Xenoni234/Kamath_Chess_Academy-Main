import fs from "node:fs";
import { parse } from "csv-parse";
import { db } from "../src/lib/db";

type PuzzleCsvRow = {
  PuzzleId: string;
  FEN: string;
  Moves: string;
  Rating: string;
  RatingDeviation: string;
  Popularity: string;
  Themes: string;
  GameUrl: string;
  OpeningTags: string;
};

const [, , csvPath, limitArg] = process.argv;
const limit = limitArg ? Number(limitArg) : Number.POSITIVE_INFINITY;

if (!csvPath || Number.isNaN(limit)) {
  console.error("Usage: npx tsx scripts/importPuzzles.ts /path/to/puzzles.csv 50000");
  process.exit(1);
}

async function flush(batch: Array<{ id: string; fen: string; moves: string; rating: number; themes: string[]; source: string }>) {
  if (batch.length === 0) return;

  await db.puzzle.createMany({ data: batch, skipDuplicates: true });
  batch.length = 0;
}

async function main() {
  const batch: Array<{ id: string; fen: string; moves: string; rating: number; themes: string[]; source: string }> = [];
  let imported = 0;

  const parser = fs.createReadStream(csvPath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }),
  );

  for await (const row of parser as AsyncIterable<PuzzleCsvRow>) {
    if (imported >= limit) break;

    const rating = Number(row.Rating);
    if (!Number.isFinite(rating) || rating < 800 || rating > 2800) {
      continue;
    }

    batch.push({
      id: row.PuzzleId,
      fen: row.FEN,
      moves: row.Moves,
      rating,
      themes: row.Themes ? row.Themes.split(/\s+/).filter(Boolean) : [],
      source: row.GameUrl || "lichess",
    });
    imported += 1;

    if (batch.length >= 1000) {
      await flush(batch);
    }

    if (imported % 5000 === 0) {
      console.log(`Imported ${imported} puzzles`);
    }
  }

  await flush(batch);
  console.log(`Done. Imported ${imported} puzzles`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
