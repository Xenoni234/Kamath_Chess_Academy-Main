import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { generateOpponentRepertoire } from "@/lib/claude";
import { createNotification } from "@/lib/notify";
import { fetchOpponentGames } from "@/lib/second/ingest";
import { buildTrie, flattenTrie, trieSummaryLines } from "@/lib/second/trie";
import { detectWeaknesses } from "@/lib/second/weakness";
import { runGraphStage } from "@/lib/second/graph";
import { mineNovelties, type NoveltyTarget } from "@/lib/second/novelty";
import { buildRepertoireLines, describeArtifact } from "@/lib/second/repertoire";
import { renderDossierPdf } from "@/lib/second/pdf";
import type { ProfileArtifact, ProfileJobData } from "@/lib/second/types";

/**
 * The opponent-profiling pipeline (Phase 4 Digital Second).
 *
 *   ingest -> Trie -> weaknesses -> transpositions -> novelties -> repertoire -> PDF
 *
 * Runs under a BullMQ worker (durable) or inline when no queue Redis is set,
 * mirroring runReportJob. Always drives the OpponentProfile row to a terminal
 * status. Every stage after ingestion degrades to empty rather than throwing, so
 * a missing Neo4j or Lichess token costs one section, not the dossier.
 */

/** How many of the opponent's games to pull. */
const MAX_GAMES = 200;
/** Cap the positions handed to the (expensive) novelty miner. */
const MAX_NOVELTY_TARGETS = 8;

export async function runProfileJob(data: ProfileJobData): Promise<void> {
  const { profileId, requestedById, handle, source, colorToPlay } = data;

  try {
    await db.opponentProfile.update({ where: { id: profileId }, data: { status: "processing" } });

    // 1. Ingest their games, recency-weighted.
    const { games, ratingSummary } = await fetchOpponentGames(handle, source, { max: MAX_GAMES });
    if (games.length === 0) {
      await db.opponentProfile.update({
        where: { id: profileId },
        data: {
          status: "failed",
          summary:
            "No games found for that account. Check the username, the site, and that the profile is public.",
        },
      });
      return;
    }

    // The colour THEY play is the opposite of the colour we prepare for.
    const theirColor: "w" | "b" = colorToPlay === "white" ? "b" : "w";
    const theirGames = games.filter((g) => g.color === theirColor);
    if (theirGames.length === 0) {
      await db.opponentProfile.update({
        where: { id: profileId },
        data: {
          status: "failed",
          summary: `No games found where ${handle} played ${theirColor === "w" ? "White" : "Black"}. Try preparing for the other colour.`,
        },
      });
      return;
    }

    // 2. Repertoire Trie.
    const trie = buildTrie(games, theirColor);
    const trieSummary = trieSummaryLines(trie);

    // 3. Weaknesses (engine-graded).
    const weaknesses = await detectWeaknesses(games, theirColor);

    // 4. Transpositions (Neo4j; skipped when not configured).
    const { transpositions, graphUsed, graphSkipReason } = await runGraphStage(
      profileId,
      trie,
      weaknesses,
    );

    // 5. Novelties at OUR decision points inside their repertoire: the position
    // right after one of their moves is one where we are to move.
    const targets: NoveltyTarget[] = [];
    const seenFens = new Set<string>();
    const pathByFen = new Map<string, string[]>();
    const walk = (node: ReturnType<typeof buildTrie>, line: string[]) => {
      for (const child of Object.values(node.children)) {
        const childLine = [...line, child.san];
        pathByFen.set(child.fen, childLine);
        walk(child, childLine);
      }
    };
    walk(trie, []);

    for (const node of flattenTrie(trie)
      .filter((n) => n.mover === theirColor && n.ply >= 4 && n.ply <= 16)
      .sort((a, b) => b.weightedCount - a.weightedCount)) {
      // After their move it is our turn — that is where we can surprise them.
      if (seenFens.has(node.fen)) continue;
      seenFens.add(node.fen);
      targets.push({ fen: node.fen, line: pathByFen.get(node.fen) ?? [] });
      if (targets.length >= MAX_NOVELTY_TARGETS) break;
    }

    const novelties = await mineNovelties(targets);

    // 6. Assemble the artifact and the recommended lines.
    const artifact: ProfileArtifact = {
      handle,
      source,
      colorToPlay,
      gamesAnalyzed: theirGames.length,
      ratingSummary,
      trieSummary,
      weaknesses,
      transpositions,
      novelties,
      graphUsed,
      graphSkipReason,
    };

    const lines = buildRepertoireLines(artifact);
    const description = describeArtifact(artifact, lines);
    const topWeakness = weaknesses[0]
      ? {
          line: weaknesses[0].line.join(" "),
          move: weaknesses[0].theirMove,
          accuracy: weaknesses[0].accuracy,
          clock: weaknesses[0].avgClockSpent,
        }
      : null;

    // 7. Narrative (Claude / Ollama / template — never throws).
    const narrative = await generateOpponentRepertoire({
      handle,
      colorToPlay,
      gamesAnalyzed: theirGames.length,
      description,
      lines: lines.map((l) => ({ moves: l.moves, rationale: l.rationale })),
      topWeakness,
      noveltyCount: novelties.length,
      transpositionCount: transpositions.length,
    });

    // 8. PDF. A rendering failure must not lose the dossier itself.
    let pdfPath: string | null = null;
    try {
      const pdf = await renderDossierPdf(artifact, lines, narrative);
      pdfPath = path.join("/tmp", `dossier-${profileId}.pdf`);
      await fs.writeFile(pdfPath, pdf);
    } catch (error) {
      console.error("[second] dossier PDF failed:", error);
      pdfPath = null;
    }

    // 9. Persist.
    await db.repertoirePlan.create({
      data: {
        profileId,
        pdfUrl: pdfPath,
        summary: narrative,
        linesJson: lines as unknown as object,
      },
    });

    await db.opponentProfile.update({
      where: { id: profileId },
      data: {
        status: "complete",
        gamesAnalyzed: theirGames.length,
        ratingSummary: ratingSummary as unknown as object,
        artifact: artifact as unknown as object,
        summary: narrative,
      },
    });

    await createNotification({
      userId: requestedById,
      type: "SYSTEM",
      title: "Opponent dossier ready",
      body: `Your preparation against ${handle} is ready to view.`,
    }).catch(() => {});
  } catch (error) {
    console.error("Opponent profiling failed:", error);
    await db.opponentProfile
      .update({ where: { id: profileId }, data: { status: "failed" } })
      .catch(() => {});
  }
}
