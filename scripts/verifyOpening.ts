/**
 * Offline verification of the Opening Trainer pipeline (Phase 5).
 *
 *   npx tsx --env-file=.env.local scripts/verifyOpening.ts "Caro-Kann Defence" black
 *
 * Runs resolve -> book -> seeds -> engine extend -> describe -> guide with no DB
 * writes. Without LICHESS_API_TOKEN the book is the spine only and extension falls
 * to the engine (still valid). Forces the template guide so no AI key is needed.
 * Asserts: an opening resolved, variations are diverse, every line reached ~15
 * moves, a best line was picked, and the guide is non-empty.
 */
process.env.AI_PROVIDER = "template";

import { resolveOpening } from "../src/lib/opening/eco";
import { buildExplorerBook } from "../src/lib/opening/explorerTree";
import { buildOpeningSeeds, pickBestLine } from "../src/lib/opening/buildOpeningRepertoire";
import { describeOpening } from "../src/lib/opening/describeOpening";
import { extendAll, DEFAULT_EXTEND_BUDGET, TARGET_PLIES } from "../src/lib/second/extend";
import { generateOpeningGuide } from "../src/lib/claude";
import type { OpeningArtifact } from "../src/lib/opening/types";

const [, , nameArg, colorArg] = process.argv;
const name = nameArg ?? "Caro-Kann Defence";
const color = (colorArg === "black" ? "black" : "white") as "white" | "black";

async function main() {
  const t0 = Date.now();
  const root = resolveOpening(name);
  if (!root) throw new Error(`FAIL: "${name}" did not resolve`);
  console.log(`Resolved: ${root.eco} ${root.name} [${root.san.join(" ")}]`);

  const { book, coverage } = await buildExplorerBook(root.san);
  console.log(`Book: queried ${coverage.positionsQueried}, withData ${coverage.positionsWithData}, token=${coverage.hasToken}`);

  const { variations, lines: seeds } = buildOpeningSeeds(root, book);
  console.log(`Seeds: ${variations.length} variations -> ${variations.map((v) => v.name.replace(root.family + ": ", "")).join(", ")}`);

  const opponentColor: "w" | "b" = color === "white" ? "b" : "w";
  const { lines } = await extendAll(seeds, [], book, opponentColor, { ...DEFAULT_EXTEND_BUDGET, depth: 14 });

  const bestLineIndex = pickBestLine(lines, color);
  const artifact: OpeningArtifact = {
    name: root.name, eco: root.eco || null, family: root.family, colorToPlay: color,
    rootMoves: root.san, rootFen: root.fen, variations, bestLineIndex,
    explorerCoverage: { ...coverage }, generatedAt: new Date().toISOString(),
  };

  // Assertions.
  const distinctNames = new Set(variations.map((v) => v.name)).size;
  const shortLines = lines.filter((l) => l.moves.length < TARGET_PLIES).map((l) => l.moves.join(" "));
  const guide = await generateOpeningGuide({
    name: root.name, colorToPlay: color, eco: artifact.eco, variationCount: variations.length,
    bestLine: bestLineIndex !== null ? lines[bestLineIndex]?.moves ?? null : null,
    description: describeOpening(artifact, lines),
  });

  console.log("\nLine lengths:", lines.map((l) => l.moves.length).join(", "));
  console.log(`Best line (${color}): ${bestLineIndex !== null ? lines[bestLineIndex].moves.join(" ") : "none"}`);
  console.log(`Guide chars: ${guide.length}`);
  console.log(`Total: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const problems: string[] = [];
  if (distinctNames !== variations.length) problems.push("variations not distinct");
  if (variations.length < 2) problems.push("too few variations");
  if (shortLines.length > 0) problems.push(`${shortLines.length} lines under ${TARGET_PLIES} plies`);
  if (bestLineIndex === null) problems.push("no best line picked");
  if (guide.trim().length === 0) problems.push("empty guide");

  if (problems.length) {
    console.error("\n❌ FAIL:", problems.join("; "));
    if (shortLines.length) console.error("   short:", shortLines.slice(0, 3));
    process.exit(1);
  }
  console.log("\n✅ PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
