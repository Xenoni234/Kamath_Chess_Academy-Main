import { pristineFetch } from "@/lib/pristineFetch";
import { launchBrowser } from "@/lib/pdf/launch";
import { createNotification } from "@/lib/notify";
import { markdownToHtml, MARKDOWN_PDF_CSS } from "@/lib/markdown/toHtml";
import { buildSelfProfile, describeSelfProfile } from "@/lib/reports/selfProfile";
import { MIN_OPENING_GAMES } from "@/lib/reports/gameStats";
import { db } from "@/lib/db";
import { generateGameReportNarrative, type GameReportStats } from "@/lib/claude";
import {
  REPORT_BUDGET,
  buildGameStats,
  normaliseChessComGames,
  normaliseLichessGames,
  type NormalisedGame,
} from "@/lib/reports/gameStats";

/**
 * The full game-report pipeline, extracted from the route so it can run under a
 * BullMQ worker (durable) or inline (fallback when no queue Redis is set).
 * Idempotent-ish: it always drives the GameReport row to a terminal status.
 */
export type ReportJobData = {
  reportId: string;
  userId: string;
  username: string;
  userEmail: string;
  lichessId?: string;
  chesscomId?: string;
};


/** Fetch a little more than we analyse — some games will not parse. */
// Must exceed REPORT_BUDGET.maxGames, or the cap that actually binds is this one and
// raising maxGames does nothing. Games are returned newest-first (Lichess `max=`) and
// newest-last (Chess.com archives, hence the negative slice below).
const FETCH_LIMIT = 120;

function htmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[char];
  });
}

async function fetchLichessGames(lichessId: string): Promise<NormalisedGame[]> {
  const response = await pristineFetch(
    `https://lichess.org/api/games/user/${encodeURIComponent(lichessId)}?max=${FETCH_LIMIT}&opening=true`,
    { headers: { Accept: "application/x-ndjson" } },
  );

  if (!response.ok) return [];

  const text = await response.text();
  const raw = text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });

  return normaliseLichessGames(raw, lichessId);
}

async function fetchChessComGames(chesscomId: string): Promise<NormalisedGame[]> {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const response = await pristineFetch(
    `https://api.chess.com/pub/player/${encodeURIComponent(chesscomId)}/games/${year}/${month}`,
    { headers: { Accept: "application/json" } },
  );

  if (!response.ok) return [];

  const data = (await response.json()) as { games?: unknown[] };
  return normaliseChessComGames((data.games ?? []).slice(-FETCH_LIMIT), chesscomId);
}

function renderReportHtml(stats: GameReportStats, narrative: string) {
  const openingRows = stats.topOpenings
    .map(
      (opening) =>
        `<tr><td>${htmlEscape(opening.name)}</td><td>${opening.count}</td><td>${
          opening.winRate === null
            ? '<span class="muted">not enough games yet</span>'
            : `${opening.winRate.toFixed(1)}%`
        }</td></tr>`,
    )
    .join("");

  const weakRows = stats.weakestOpenings
    .map(
      (opening) =>
        `<tr><td>${htmlEscape(opening.name)}</td><td>${opening.accuracy.toFixed(1)}%</td><td>${opening.count}</td></tr>`,
    )
    .join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { font-family: Arial, sans-serif; color: #111827; margin: 40px; line-height: 1.5; }
    h1 { font-size: 28px; margin-bottom: 4px; }
    h2 { font-size: 18px; margin-top: 28px; }
    .metric { display: inline-block; margin: 12px 24px 12px 0; }
    .metric strong { display: block; font-size: 22px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; }
    th { background: #f3f4f6; }
    .footnote { margin-top: 28px; font-size: 11px; color: #6b7280; }
    .muted { color: #6b7280; font-style: italic; }
    ${MARKDOWN_PDF_CSS}
  </style>
</head>
<body>
  <h1>KCA Game Report: ${htmlEscape(stats.username)}</h1>
  <div class="metric"><strong>${stats.totalGames}</strong>Games analysed</div>
  <div class="metric"><strong>${stats.overallAccuracy.toFixed(1)}%</strong>Overall accuracy</div>
  <div class="metric"><strong>${stats.blunderRate.toFixed(1)}%</strong>Blunder rate</div>
  <div class="metric"><strong>${stats.movesAnalyzed}</strong>Moves analysed</div>
  <div class="narrative">${markdownToHtml(narrative)}</div>
  <h2>Accuracy by phase</h2>
  <table>
    <thead><tr><th>Opening</th><th>Middlegame</th><th>Endgame</th></tr></thead>
    <tbody><tr>
      <td>${stats.openingAccuracy.toFixed(1)}%</td>
      <td>${stats.middlegameAccuracy.toFixed(1)}%</td>
      <td>${stats.endgameAccuracy.toFixed(1)}%</td>
    </tr></tbody>
  </table>
  <h2>Most played openings</h2>
  <table>
    <thead><tr><th>Opening</th><th>Games</th><th>Score</th></tr></thead>
    <tbody>${openingRows || '<tr><td colspan="3" class="muted">We could not read the opening names for these games.</td></tr>'}</tbody>
  </table>
  <h2>Lowest accuracy openings</h2>
  <table>
    <thead><tr><th>Opening</th><th>Accuracy</th><th>Games</th></tr></thead>
    <tbody>${weakRows || `<tr><td colspan="3" class="muted">No single opening has been played ${MIN_OPENING_GAMES} times yet — play a few more and this will fill in.</td></tr>`}</tbody>
  </table>
  <p class="footnote">
    Positions evaluated with Stockfish 18 at depth ${REPORT_BUDGET.depth}, skipping the first
    ${REPORT_BUDGET.bookPlies} half-moves as opening theory. Accuracy uses the standard
    win-percentage model, so it is comparable with Lichess's figure for the same games.
  </p>
</body>
</html>`;
}

export async function runReportJob(data: ReportJobData): Promise<void> {
  // `userEmail` is still on the job payload but deliberately unused: reports are not emailed.
  const { reportId, userId, username, lichessId, chesscomId } = data;
  try {
    await db.gameReport.update({ where: { id: reportId }, data: { status: "processing" } });

    const [lichessGames, chessComGames] = await Promise.all([
      lichessId ? fetchLichessGames(lichessId) : Promise.resolve<NormalisedGame[]>([]),
      chesscomId ? fetchChessComGames(chesscomId) : Promise.resolve<NormalisedGame[]>([]),
    ]);

    const games = [...lichessGames, ...chessComGames];
    if (games.length === 0) {
      await db.gameReport.update({
        where: { id: reportId },
        data: {
          status: "failed",
          summary: "No games found for that account. Check the username and that the profile is public.",
        },
      });
      return;
    }

    const displayName = lichessId ?? chesscomId ?? username;
    const { stats, gamesAnalyzed } = await buildGameStats(displayName, games);

    if (gamesAnalyzed === 0) {
      await db.gameReport.update({
        where: { id: reportId },
        data: { status: "failed", summary: "Could not analyse any of those games." },
      });
      return;
    }

    // Deep self-profile: the same engine stages the opponent dossier runs, pointed at the
    // student's own games. This is the difference between "you scored 87.6%" and "here is
    // what you are actually weak at", which is the whole point of a report.
    //
    // Wrapped so it can only ever ADD. It needs a public handle, a second ingest and a
    // long engine pass, and any of those can fail — when they do the student still gets
    // the report they got before, and the narrative is told the section is missing rather
    // than being allowed to imply there was nothing to find.
    const profileHandle = lichessId ?? chesscomId;
    if (profileHandle) {
      try {
        const profile = await buildSelfProfile(
          profileHandle,
          lichessId ? "LICHESS" : "CHESSCOM",
        );
        if (profile) stats.selfProfile = describeSelfProfile(profile);
      } catch (error) {
        console.error("[report] self-profile failed; continuing without it:", error);
      }
    }

    const narrative = await generateGameReportNarrative(stats);

    const browser = await launchBrowser();
    let pdfBuffer: Buffer;
    try {
      const page = await browser.newPage();
      await page.setContent(renderReportHtml(stats, narrative), { waitUntil: "load" });
      pdfBuffer = Buffer.from(await page.pdf({ format: "A4" }));
    } finally {
      await browser.close();
    }

    // The PDF is stored on the row, not in /tmp, and it is NOT emailed.
    //
    // /tmp is wiped on every redeploy, so the download degraded into "this report's file
    // has expired — check your email", which put a child's own report behind their inbox.
    // The report now simply stays in their account, viewable and downloadable, for as long
    // as the row exists. Nothing is sent unasked.
    await db.gameReport.update({
      where: { id: reportId, userId },
      data: {
        status: "complete",
        gamesAnalyzed,
        // Prisma's Bytes wants a plain Uint8Array, not a Node Buffer.
        pdf: new Uint8Array(pdfBuffer),
        summary: narrative,
      },
    });

    // The email USED to be how a student found out the report existed. Removing it left
    // nothing at all: the reports page only learns the job finished while it is open and
    // polling, so anyone who navigated away was never told. The bell is the replacement,
    // and it is the same one the dossier job already rings.
    await createNotification({
      userId,
      type: "SYSTEM",
      title: "Your game report is ready",
      body: `We looked at ${gamesAnalyzed} of your games. Open Reports to read it.`,
    }).catch(() => {});
  } catch (error) {
    console.error("Report generation failed:", error);
    await db.gameReport.update({ where: { id: reportId }, data: { status: "failed" } });

    // A silent failure is worse than a visible one: without this the row sits on "failed"
    // and the student waits for something that is never coming.
    await createNotification({
      userId,
      type: "SYSTEM",
      title: "We could not finish your report",
      body: "Something went wrong while looking at your games. Please try making it again.",
    }).catch(() => {});
  }
}
