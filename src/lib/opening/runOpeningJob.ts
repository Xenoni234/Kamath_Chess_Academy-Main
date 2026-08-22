import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { generateOpeningGuide } from "@/lib/claude";
import { createNotification } from "@/lib/notify";
import { resolveByUci, resolveOpening } from "./eco";
import { buildExplorerBook } from "./explorerTree";
import { buildOpeningSeeds, pickBestLine } from "./buildOpeningRepertoire";
import { describeOpening } from "./describeOpening";
import { renderOpeningPdf } from "./pdf";
import { extendAll, DEFAULT_EXTEND_BUDGET } from "@/lib/second/extend";
import type { OpeningArtifact, OpeningJobData } from "./types";

/**
 * The opening-trainer pipeline (Phase 5).
 *
 *   resolve -> Explorer book -> seed variations -> extend -> describe -> guide -> PDF
 *
 * Runs under a BullMQ worker (durable) or inline when no queue Redis is set,
 * mirroring runProfileJob. Always drives the OpeningRepertoire row to a terminal
 * status. Every stage after seeding degrades rather than throwing: a missing
 * Lichess token costs population weighting, a missing AI key costs only the prose.
 *
 * Repertoires are GLOBAL and cached — the row is keyed by (name+colour+version) and
 * shared across users — so this runs at most once per opening until regenerated.
 */

/** Openings are far cheaper than dossiers (no ingest, ~13 lines), but bound it. */
const JOB_TIMEOUT_MS = 15 * 60 * 1000;

export async function runOpeningJob(data: OpeningJobData): Promise<void> {
  try {
    await Promise.race([
      runOpeningJobInner(data),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`opening job exceeded ${JOB_TIMEOUT_MS}ms`)), JOB_TIMEOUT_MS).unref?.(),
      ),
    ]);
  } catch (error) {
    console.error("[opening] job aborted:", error);
    await db.openingRepertoire.update({ where: { id: data.repertoireId }, data: { status: "failed" } }).catch(() => {});
  }
}

function stageTimer() {
  let last = Date.now();
  return (stage: string) => {
    const now = Date.now();
    console.log(`[opening] ${stage}: ${((now - last) / 1000).toFixed(1)}s`);
    last = now;
  };
}

async function runOpeningJobInner(data: OpeningJobData): Promise<void> {
  const { repertoireId, name, colorToPlay, rootUci, requestedById } = data;
  const mark = stageTimer();

  try {
    await db.openingRepertoire.update({ where: { id: repertoireId }, data: { status: "processing" } });

    // 1. Resolve the opening back to concrete moves (exact by UCI, else by name).
    const root = resolveByUci(rootUci) ?? resolveOpening(name);
    if (!root) {
      await db.openingRepertoire.update({
        where: { id: repertoireId },
        data: { status: "failed", summary: `Could not resolve the opening "${name}".` },
      });
      return;
    }

    // 2. Build the "book" of popular human replies from the Explorer.
    const { book, coverage } = await buildExplorerBook(root.san);
    mark("explorer-book");

    // 3. Seed a diverse set of named variations.
    const { variations, lines: seeds } = buildOpeningSeeds(root, book);
    mark("seeds");

    // 4. Extend each seed to ~15 full moves via the engine (opponent = the side we
    //    do NOT play). Reuses the dossier's extender unchanged.
    const opponentColor: "w" | "b" = colorToPlay === "white" ? "b" : "w";
    const { lines } = await extendAll(seeds, [], book, opponentColor, DEFAULT_EXTEND_BUDGET);
    mark("extend");

    const bestLineIndex = pickBestLine(lines, colorToPlay);

    // 5. Assemble the artifact.
    const artifact: OpeningArtifact = {
      name: root.name,
      eco: root.eco || null,
      family: root.family,
      colorToPlay,
      rootMoves: root.san,
      rootFen: root.fen,
      variations,
      bestLineIndex,
      explorerCoverage: {
        positionsQueried: coverage.positionsQueried,
        positionsWithData: coverage.positionsWithData,
        hasToken: coverage.hasToken,
      },
      generatedAt: new Date().toISOString(),
    };

    // 6. AI coaching guide (never throws — template fallback).
    const description = describeOpening(artifact, lines);
    const guide = await generateOpeningGuide({
      name: root.name,
      colorToPlay,
      eco: artifact.eco,
      variationCount: variations.length,
      bestLine: bestLineIndex !== null ? lines[bestLineIndex]?.moves ?? null : null,
      description,
    });
    mark("guide");

    // 7. PDF (degrades to null — the repertoire is still saved).
    let pdfPath: string | null = null;
    try {
      const pdf = await renderOpeningPdf(artifact, lines, guide);
      pdfPath = path.join("/tmp", `opening-${repertoireId}.pdf`);
      await fs.writeFile(pdfPath, pdf);
    } catch (error) {
      console.error("[opening] PDF generation failed:", error);
      pdfPath = null;
    }
    mark("pdf");

    // 8. Persist as complete.
    await db.openingRepertoire.update({
      where: { id: repertoireId },
      data: {
        status: "complete",
        eco: artifact.eco,
        artifact: artifact as unknown as object,
        linesJson: lines as unknown as object,
        summary: guide,
        pdfUrl: pdfPath,
      },
    });

    // 9. Notify the requester (best-effort).
    await createNotification({
      userId: requestedById,
      type: "SYSTEM",
      title: "Opening repertoire ready",
      body: `Your ${root.name} repertoire (${colorToPlay}) is ready to study.`,
    }).catch(() => {});
  } catch (error) {
    console.error("[opening] job failed:", error);
    await db.openingRepertoire.update({ where: { id: repertoireId }, data: { status: "failed" } }).catch(() => {});
  }
}
