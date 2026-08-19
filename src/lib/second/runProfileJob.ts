import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { generateOpponentRepertoire } from "@/lib/claude";
import { createNotification } from "@/lib/notify";
import { queueEnabled } from "@/lib/queue/connection";
import { fetchOpponentGamesMulti } from "@/lib/second/ingest";
import { buildTrie, flattenTrie, trieSummaryLines } from "@/lib/second/trie";
import { detectWeaknesses } from "@/lib/second/weakness";
import { scanGames } from "@/lib/second/scan";
import { profileTactics } from "@/lib/second/tactics";
import { profileBehaviour } from "@/lib/second/behaviour";
import { profileEvolution } from "@/lib/second/evolution";
import { runGraphStage } from "@/lib/second/graph";
import { mineNovelties, type NoveltyTarget } from "@/lib/second/novelty";
import { buildRepertoireLines, describeArtifact } from "@/lib/second/repertoire";
import { extendAll } from "@/lib/second/extend";
import { renderDossierPdf } from "@/lib/second/pdf";
import { SOURCE_LABEL } from "@/lib/second/types";
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

/** How many games to pull per account. */
const PER_ACCOUNT_MAX = 200;
/** Ceiling across all merged accounts. */
const TOTAL_MAX = 1000;
/**
 * Ceiling when the job is running INLINE in the Next process (no queue Redis).
 * Reducing beats refusing — dev depends on the inline path — but a silently
 * smaller dossier is exactly the untrustworthiness this stage exists to remove,
 * so the reduction is flagged on the artifact and rendered.
 */
const INLINE_TOTAL_MAX = 400;
/** Cap the positions handed to the (expensive) novelty miner. */
const MAX_NOVELTY_TARGETS = 8;

/**
 * Ingest gets its own bound, well inside the job ceiling.
 *
 * Five accounts, one of them behind a wedged connection, must not consume the
 * whole run. On timeout the pipeline continues with whatever arrived: a dossier
 * built from three of five accounts that *says so* beats a 30-minute wall
 * followed by `status: failed`.
 */
const INGEST_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * Ceiling on a whole profiling run.
 *
 * Generous: engine stages alone can legitimately take ~20 minutes on the deep
 * settings. The point is not to be tight, it is that *some* bound exists — a
 * stage that hangs (a stalled AI response, a wedged engine) previously left the
 * row on "processing" forever with nothing able to move it, and no error.
 */
const JOB_TIMEOUT_MS = 30 * 60 * 1000;

export async function runProfileJob(data: ProfileJobData): Promise<void> {
  try {
    await Promise.race([
      runProfileJobInner(data),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`profiling job exceeded ${JOB_TIMEOUT_MS}ms`)),
          JOB_TIMEOUT_MS,
        ).unref?.(),
      ),
    ]);
  } catch (error) {
    // `runProfileJobInner` marks its own failures; this catches the case where
    // it never returns at all, so the row does not stay "processing" forever.
    console.error("[second] profiling job aborted:", error);
    await db.opponentProfile
      .update({ where: { id: data.profileId }, data: { status: "failed" } })
      .catch(() => {});
  }
}

/**
 * Per-stage timing. This pipeline has many expensive stages and no visibility
 * into which one is slow — the last regression cost a 20-minute run and was
 * only found by bisecting by hand.
 */
function stageTimer() {
  const started = Date.now();
  let last = started;
  return {
    mark(stage: string) {
      const now = Date.now();
      console.log(`[second] ${stage}: ${((now - last) / 1000).toFixed(1)}s`);
      last = now;
    },
    total() {
      return ((Date.now() - started) / 1000).toFixed(1);
    },
  };
}

async function runProfileJobInner(data: ProfileJobData): Promise<void> {
  const { profileId, requestedById, handle, source, colorToPlay, fideId } = data;
  // Jobs enqueued before multi-account support carry only handle/source, and
  // those payloads are JSON sitting in Redis — a deploy landing while jobs are
  // queued must not crash the worker.
  const accounts = data.accounts?.length ? data.accounts : [{ handle, source }];
  const timer = stageTimer();

  try {
    await db.opponentProfile.update({ where: { id: profileId }, data: { status: "processing" } });

    // 1. Ingest their games across every account, merged and recency-weighted.
    const inline = !queueEnabled();
    const ingestAbort = new AbortController();
    const ingestTimer = setTimeout(() => ingestAbort.abort(), INGEST_TIMEOUT_MS);
    let merged;
    try {
      merged = await fetchOpponentGamesMulti(accounts, {
        perAccountMax: PER_ACCOUNT_MAX,
        totalMax: inline ? INLINE_TOTAL_MAX : TOTAL_MAX,
        signal: ingestAbort.signal,
        // A FIDE id pulls the opponent's OTB games in as a BROADCAST account.
        fideId: fideId || undefined,
      });
    } finally {
      clearTimeout(ingestTimer);
    }
    const { games, ratingSummary } = merged;
    const ingestDiagnostics = {
      ...merged.diagnostics,
      ...(inline ? { budgetReduced: true } : {}),
    };

    if (games.length === 0) {
      // Name the accounts and why each produced nothing — "no games found" over
      // a rate-limited account sends you checking a username that was fine.
      const detail = merged.accounts
        .map((a) => {
          const reason =
            a.status === "not-found"
              ? "not found"
              : a.status === "rate-limited"
                ? "rate-limited by the site"
                : a.status === "error"
                  ? "could not be reached"
                  : "returned no games";
          return `${a.displayName ?? a.handle} (${SOURCE_LABEL[a.source]}): ${reason}`;
        })
        .join("; ");
      await db.opponentProfile.update({
        where: { id: profileId },
        data: {
          status: "failed",
          summary: `No games found. ${detail}. Check the usernames, the sites, and that the profiles are public.`,
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
          summary: `No games found where ${accounts.map((a) => a.handle).join(" / ")} played ${
            theirColor === "w" ? "White" : "Black"
          }. Try preparing for the other colour.`,
        },
      });
      return;
    }

    // 2. Repertoire Trie.
    timer.mark("ingest");
    const trie = buildTrie(games, theirColor);
    const trieSummary = trieSummaryLines(trie);

    // 3. Novelty targets — OUR decision points inside their repertoire: the
    // position right after one of their moves is one where we are to move.
    // Derived from the trie alone, so this needs nothing from the weakness pass.
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

    // 4. Weaknesses and novelties are fully independent of each other — one
    // reads the games, the other the trie — so they run concurrently instead of
    // back to back. Each uses its own engine.
    const [{ weaknesses, clockBasis }, novelties] = await Promise.all([
      detectWeaknesses(games, theirColor),
      mineNovelties(targets),
    ]);

    timer.mark("weakness+novelty");

    // 4b. Whole-game scan, then the two profiles derived from it. One engine
    // pass serves both: the grading is the expensive part and they need the
    // same records, so running it twice would double the cost of the most
    // expensive stage for nothing. Runs after the pair above rather than beside
    // them because it saturates the engine pool on its own.
    //
    // Degrades to undefined rather than throwing — a scan failure costs two
    // sections, not the dossier.
    let tactical;
    let behaviour;
    let evolution;
    try {
      const scan = await scanGames(games, theirColor);
      tactical = profileTactics(scan.moves, scan.games.length);
      behaviour = profileBehaviour(scan.games, scan.moves);
      // Same scan, sliced by era. Cheap — no extra engine work.
      evolution = profileEvolution(scan.games, scan.moves);
    } catch (error) {
      console.error("[second] whole-game scan failed:", error);
      tactical = undefined;
      behaviour = undefined;
      evolution = undefined;
    }

    timer.mark("tactical+behavioural scan");

    // 5. Transpositions (Neo4j; skipped when not configured). This genuinely
    // needs the weaknesses, so it cannot join the pair above.
    const { transpositions, graphUsed, graphSkipReason } = await runGraphStage(
      profileId,
      trie,
      weaknesses,
    );

    timer.mark("neo4j transpositions");

    // 6. Assemble the artifact and the recommended lines.
    const artifact: ProfileArtifact = {
      handle,
      source,
      accounts: merged.accounts,
      ingest: ingestDiagnostics,
      recencyReferenceAt: new Date(merged.recencyReferenceMs).toISOString(),
      clockBasis,
      colorToPlay,
      gamesAnalyzed: theirGames.length,
      ratingSummary,
      trieSummary,
      weaknesses,
      transpositions,
      novelties,
      tactical,
      behaviour,
      evolution,
      graphUsed,
      graphSkipReason,
    };

    // 6b. Extend the recommended lines AND the transposition bypasses into real
    // variations. The stages above only produce the path *to* a point of
    // interest; this plays it out using the opponent's own book while it lasts,
    // then Stockfish.
    //
    // One call, because `buildRepertoireLines` already folds the first few
    // bypasses into the lines — extending them separately did that work twice.
    // Failure returns the short lines unchanged rather than losing the dossier.
    const shortLines = buildRepertoireLines(artifact);
    const extended = await extendAll(
      shortLines,
      artifact.transpositions.map((t) => t.bypass),
      trie,
      theirColor,
    );
    const lines = extended.lines;

    artifact.transpositions = artifact.transpositions.map((t, i) => ({
      ...t,
      extended: extended.moveOrders[i]?.moves,
      outOfBookAtPly: extended.moveOrders[i]?.outOfBookAtPly,
    }));

    timer.mark("extend lines");

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
      // The AI layer takes one label. Say plainly that it describes a human
      // across several accounts, or the prose talks about a single username.
      handle: accounts.length > 1 ? `${handle} (+${accounts.length - 1} more accounts)` : handle,
      colorToPlay,
      gamesAnalyzed: theirGames.length,
      description,
      lines: lines.map((l) => ({ moves: l.moves, rationale: l.rationale })),
      topWeakness,
      noveltyCount: novelties.length,
      transpositionCount: transpositions.length,
    });

    timer.mark("AI narrative");

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

    timer.mark("PDF");

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
