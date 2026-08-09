import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import puppeteer from "puppeteer";
import { Resend } from "resend";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { generateGameReportNarrative, type GameReportStats } from "@/lib/claude";
import {
  REPORT_BUDGET,
  buildGameStats,
  normaliseChessComGames,
  normaliseLichessGames,
  type NormalisedGame,
} from "@/lib/reports/gameStats";
import { reportGenerateSchema } from "@/lib/validations/phase2";

export const runtime = "nodejs";

const resend = new Resend(process.env.RESEND_API_KEY);

/** Fetch a little more than we analyse — some games will not parse. */
const FETCH_LIMIT = 50;

function htmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[char];
  });
}

async function fetchLichessGames(lichessId: string): Promise<NormalisedGame[]> {
  const response = await fetch(
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
  const response = await fetch(
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
        `<tr><td>${htmlEscape(opening.name)}</td><td>${opening.count}</td><td>${opening.winRate.toFixed(1)}%</td></tr>`,
    )
    .join("");

  const weakRows = stats.weakestOpenings
    .map(
      (opening) =>
        `<tr><td>${htmlEscape(opening.name)}</td><td>${opening.accuracy.toFixed(1)}%</td></tr>`,
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
  </style>
</head>
<body>
  <h1>KCA Game Report: ${htmlEscape(stats.username)}</h1>
  <div class="metric"><strong>${stats.totalGames}</strong>Games analysed</div>
  <div class="metric"><strong>${stats.overallAccuracy.toFixed(1)}%</strong>Overall accuracy</div>
  <div class="metric"><strong>${stats.blunderRate.toFixed(1)}%</strong>Blunder rate</div>
  <div class="metric"><strong>${stats.movesAnalyzed}</strong>Moves analysed</div>
  ${narrative
    .split("\n")
    .filter(Boolean)
    .map((paragraph) => `<p>${htmlEscape(paragraph)}</p>`)
    .join("")}
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
    <thead><tr><th>Opening</th><th>Games</th><th>Win rate</th></tr></thead>
    <tbody>${openingRows || "<tr><td colspan=\"3\">No opening data.</td></tr>"}</tbody>
  </table>
  <h2>Lowest accuracy openings</h2>
  <table>
    <thead><tr><th>Opening</th><th>Accuracy</th></tr></thead>
    <tbody>${weakRows || "<tr><td colspan=\"2\">No opening data.</td></tr>"}</tbody>
  </table>
  <p class="footnote">
    Positions evaluated with Stockfish 18 at depth ${REPORT_BUDGET.depth}, skipping the first
    ${REPORT_BUDGET.bookPlies} half-moves as opening theory. Accuracy uses the standard
    win-percentage model, so it is comparable with Lichess's figure for the same games.
  </p>
</body>
</html>`;
}

async function runReportJob(
  reportId: string,
  userId: string,
  username: string,
  userEmail: string,
  ids: { lichessId?: string; chesscomId?: string },
) {
  try {
    await db.gameReport.update({ where: { id: reportId }, data: { status: "processing" } });

    const [lichessGames, chessComGames] = await Promise.all([
      ids.lichessId ? fetchLichessGames(ids.lichessId) : Promise.resolve<NormalisedGame[]>([]),
      ids.chesscomId ? fetchChessComGames(ids.chesscomId) : Promise.resolve<NormalisedGame[]>([]),
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

    // Engine analysis of the player's own moves — this is what makes the
    // numbers real. Bounded by REPORT_BUDGET; see gameStats.ts.
    const displayName = ids.lichessId ?? ids.chesscomId ?? username;
    const { stats, gamesAnalyzed } = await buildGameStats(displayName, games);

    if (gamesAnalyzed === 0) {
      await db.gameReport.update({
        where: { id: reportId },
        data: { status: "failed", summary: "Could not analyse any of those games." },
      });
      return;
    }

    const narrative = await generateGameReportNarrative(stats);

    const browser = await puppeteer.launch({ headless: true });
    let pdfBuffer: Buffer;
    try {
      const page = await browser.newPage();
      await page.setContent(renderReportHtml(stats, narrative), { waitUntil: "load" });
      pdfBuffer = Buffer.from(await page.pdf({ format: "A4" }));
    } finally {
      await browser.close();
    }

    // NOTE: /tmp is ephemeral and per-instance. The emailed attachment is the
    // durable copy; the download route serves this file while it survives.
    const pdfPath = path.join("/tmp", `report-${reportId}.pdf`);
    await fs.writeFile(pdfPath, pdfBuffer);

    const emailFrom = process.env.EMAIL_FROM;
    if (!emailFrom) {
      throw new Error("EMAIL_FROM is not configured");
    }

    await resend.emails.send({
      from: emailFrom,
      to: userEmail,
      subject: "Your KCA Game Report is ready",
      html: "<p>Your game report is attached.</p>",
      attachments: [{ filename: "report.pdf", content: pdfBuffer }],
    });

    await db.gameReport.update({
      where: { id: reportId, userId },
      data: {
        status: "complete",
        gamesAnalyzed,
        pdfUrl: pdfPath,
        emailSentAt: new Date(),
        summary: narrative,
      },
    });
  } catch (error) {
    console.error("Report generation failed:", error);
    await db.gameReport.update({ where: { id: reportId }, data: { status: "failed" } });
  }
}

export async function POST(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;

  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = verifyAccessToken(token);
    const rawBody = await request.json();
    const parsed = reportGenerateSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ success: false, message: parsed.error.issues[0].message }, { status: 400 });
    }
    const body = parsed.data;
    const user = await db.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, username: true, email: true },
    });

    if (!user) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const report = await db.gameReport.create({
      data: {
        userId: user.id,
        lichessId: body.lichessId,
        chesscomId: body.chesscomId,
        status: "pending",
      },
    });

    // Fire-and-forget. A real queue (bullmq is already a dependency) is Phase 3
    // work; until then a server restart mid-job leaves the row in "processing".
    setImmediate(() => {
      void runReportJob(report.id, user.id, user.username, user.email, body);
    });

    return NextResponse.json({ success: true, reportId: report.id });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
