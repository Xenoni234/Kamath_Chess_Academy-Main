/**
 * Track F5 — render an opponent dossier to PDF.
 *
 * Same Puppeteer HTML->PDF approach as the Phase 2 game report
 * (src/lib/reports/runReportJob.ts). Written to /tmp, which is ephemeral and
 * per-instance, so the download route may legitimately 404 for older dossiers.
 */
import puppeteer from "puppeteer";
import type { ProfileArtifact, RepertoireLine } from "@/lib/second/types";

function htmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[char];
  });
}

export function renderDossierHtml(
  artifact: ProfileArtifact,
  lines: RepertoireLine[],
  narrative: string,
): string {
  const ACCOUNT_STATUS_COPY: Record<string, string> = {
    ok: "",
    "not-found": " — account not found",
    "rate-limited": " — rate-limited by the site",
    error: " — could not be reached",
  };

  const sourceRows = (artifact.accounts ?? [])
    .map((a) => {
      const range =
        a.oldestPlayedAt && a.newestPlayedAt
          ? `${a.oldestPlayedAt.slice(0, 10)} → ${a.newestPlayedAt.slice(0, 10)}`
          : "—";
      // meanWeight is what makes the shared recency reference auditable: an
      // account at 0.1 is three half-lives stale and barely shaped this dossier.
      const stale = a.gamesUsed > 0 && a.meanWeight < 0.25;
      return `<tr><td class="mono">${htmlEscape(a.handle)}</td><td>${
        a.source === "LICHESS" ? "Lichess" : "Chess.com"
      }${htmlEscape(ACCOUNT_STATUS_COPY[a.status] ?? "")}</td><td>${a.gamesUsed}</td><td>${range}</td><td${
        stale ? ' class="muted"' : ""
      }>${a.meanWeight.toFixed(2)}${stale ? " (stale)" : ""}</td></tr>`;
    })
    .join("");

  const MOTIF_LABEL: Record<string, string> = {
    fork: "Forks",
    skewer: "Skewers",
    discoveredAttack: "Discovered attacks",
    hangingPiece: "Loose pieces",
    backRankMate: "Back-rank mates",
    pin: "Pins",
  };

  const tacticalRows = (artifact.tactical?.motifs ?? [])
    .map((m) => {
      const thin = m.opportunities < (artifact.tactical?.minOpportunities ?? 6);
      const label = htmlEscape(MOTIF_LABEL[m.motif] ?? m.motif);
      if (thin) {
        return `<tr><td>${label}</td><td colspan="3" class="muted">Not enough evidence (${m.opportunities} seen)</td><td>${(m.detectorPrecision * 100).toFixed(0)}%</td></tr>`;
      }
      return `<tr><td>${label}</td><td>${m.missed} / ${m.opportunities}</td><td>${(m.missRate * 100).toFixed(0)}%</td><td>${(m.missRateLow * 100).toFixed(0)}–${(m.missRateHigh * 100).toFixed(0)}%</td><td>${(m.detectorPrecision * 100).toFixed(0)}%</td></tr>`;
    })
    .join("");

  const behaviour = artifact.behaviour;
  const behaviourRows = behaviour
    ? [
        ...(behaviour.clockDataAvailable
          ? [...behaviour.timePressure, ...behaviour.longThink]
          : []),
        ...behaviour.tilt,
        ...behaviour.structures,
      ]
        .filter((bucket) => bucket.n >= behaviour.minSamples)
        .map(
          (bucket) =>
            `<tr><td>${htmlEscape(bucket.label)}</td><td>${bucket.accuracy.toFixed(1)}%</td><td>${bucket.accuracyLow.toFixed(1)}–${bucket.accuracyHigh.toFixed(1)}%</td><td>${(bucket.blunderRate * 100).toFixed(0)}%</td><td>${bucket.n}</td></tr>`,
        )
        .concat(
          behaviour.terminations.map(
            (t) =>
              `<tr><td>Losses ending: ${htmlEscape(t.label)}</td><td colspan="3" class="muted">${(t.share * 100).toFixed(0)}% of ${behaviour.lossesAnalyzed} losses</td><td>${t.count}</td></tr>`,
          ),
        )
        .join("")
    : "";

  const weaknessRows =
    artifact.weaknesses
      .map(
        (w) =>
          `<tr><td class="mono">${htmlEscape(w.line.join(" ") || "(start)")}</td><td class="mono">${htmlEscape(
            w.theirMove,
          )}</td><td>${w.accuracy.toFixed(1)}%</td><td>${w.avgClockSpent ?? "—"}</td><td>${w.weightedFrequency}</td></tr>`,
      )
      .join("") || `<tr><td colspan="5">No clear weaknesses detected.</td></tr>`;

  const noveltyRows =
    artifact.novelties
      .map(
        (n) =>
          `<tr><td class="mono">${htmlEscape(n.line.join(" ") || "(start)")}</td><td class="mono">${htmlEscape(
            n.move,
          )}</td><td>${n.evalCp ?? "—"}cp</td><td>${
            n.explorerShare === null ? "—" : `${(n.explorerShare * 100).toFixed(1)}%`
          }</td></tr>`,
      )
      .join("") || `<tr><td colspan="4">No novelties found.</td></tr>`;

  const transpositionRows =
    artifact.transpositions
      .map(
        (t) =>
          `<tr><td class="mono">${htmlEscape(t.bypass.join(" "))}</td><td class="mono">${htmlEscape(
            t.mainLine.join(" "),
          )}</td></tr>`,
      )
      .join("") ||
    `<tr><td colspan="2">${
      artifact.graphUsed
        ? "No transpositions found."
        : artifact.graphSkipReason === "not-configured"
          ? "Transposition analysis did not run (graph database not configured)."
          : artifact.graphSkipReason === "failed"
            ? "Transposition analysis failed while this dossier was generated."
            : "Transposition analysis unavailable for this dossier."
    }</td></tr>`;

  const lineItems =
    lines
      .map(
        (l) =>
          `<li><span class="tag">${htmlEscape(l.tag)}</span> <span class="mono">${htmlEscape(
            l.moves.join(" "),
          )}</span><br/><span class="muted">${htmlEscape(l.rationale)}</span></li>`,
      )
      .join("") || "<li>No lines recommended.</li>";

  const multiAccount = (artifact.accounts?.length ?? 0) > 1;
  const ratings =
    artifact.ratingSummary
      .filter((r) => r.rating)
      // Older dossiers have no `handle` on these entries; render them as before
      // rather than printing "undefined blitz 1800".
      .map((r) =>
        multiAccount && r.handle
          ? `${htmlEscape(r.handle)} ${htmlEscape(r.format)} ${r.rating}`
          : `${htmlEscape(r.format)} ${r.rating}`,
      )
      .join(" · ") || "unknown";

  const title = artifact.accounts?.length
    ? artifact.accounts.map((a) => a.handle).join(" / ")
    : artifact.handle;

  const clockNote = artifact.clockBasis?.initialSec
    ? `Think time is increment-corrected and measured only on their ~${artifact.clockBasis.initialSec}s games (${artifact.clockBasis.gamesUsed} games; ${artifact.clockBasis.gamesExcluded} excluded as a different time control).`
    : "No usable clock data in these games, so no think-time figures are given.";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { font-family: Arial, sans-serif; color: #111827; margin: 40px; line-height: 1.5; }
    h1 { font-size: 26px; margin-bottom: 2px; }
    h2 { font-size: 17px; margin-top: 26px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
    .sub { color: #6b7280; font-size: 12px; margin-bottom: 16px; }
    .metric { display: inline-block; margin: 10px 22px 10px 0; }
    .metric strong { display: block; font-size: 20px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
    th, td { border: 1px solid #d1d5db; padding: 6px; text-align: left; }
    th { background: #f3f4f6; }
    .mono { font-family: "Courier New", monospace; }
    .muted { color: #4b5563; font-size: 12px; }
    .tag { display: inline-block; background: #111827; color: #fff; border-radius: 3px; padding: 1px 6px; font-size: 10px; text-transform: uppercase; }
    ol { padding-left: 18px; } li { margin-bottom: 10px; }
    .footnote { margin-top: 26px; font-size: 10px; color: #6b7280; }
  </style>
</head>
<body>
  <h1>Opponent Dossier: ${htmlEscape(title)}</h1>
  <div class="sub">${htmlEscape(ratings)} · you play ${htmlEscape(artifact.colorToPlay)}</div>

  <div class="metric"><strong>${artifact.gamesAnalyzed}</strong>Games profiled</div>
  <div class="metric"><strong>${artifact.weaknesses.length}</strong>Weaknesses</div>
  <div class="metric"><strong>${artifact.novelties.length}</strong>Novelties</div>
  <div class="metric"><strong>${artifact.transpositions.length}</strong>Transpositions</div>

  <h2>Briefing</h2>
  ${narrative
    .split("\n")
    .filter(Boolean)
    .map((p) => `<p>${htmlEscape(p)}</p>`)
    .join("")}

  <h2>Recommended repertoire</h2>
  <ol>${lineItems}</ol>

  ${
    sourceRows
      ? `<h2>Sources</h2>
  <table>
    <thead><tr><th>Account</th><th>Site</th><th>Games used</th><th>Date range</th><th>Recency</th></tr></thead>
    <tbody>${sourceRows}</tbody>
  </table>
  <p class="muted">Recency is the mean weight of that account's games — 1.00 is current, below 0.25 means most of its games are over a year old and barely shaped this dossier.</p>`
      : ""
  }

  ${
    tacticalRows
      ? `<h2>Tactical profile</h2>
  <table>
    <thead><tr><th>Motif</th><th>Missed</th><th>Rate</th><th>95% range</th><th>Detector</th></tr></thead>
    <tbody>${tacticalRows}</tbody>
  </table>
  <p class="muted">Measured over ${artifact.tactical?.gamesScanned ?? 0} whole games (${artifact.tactical?.positionsScanned ?? 0} of their own moves engine-graded). A chance is a position where Stockfish's best move was that tactic. "Detector" is the motif classifier's precision against Lichess's own labelled puzzles — read the 95% range, not the single rate.</p>`
      : ""
  }

  ${
    behaviourRows
      ? `<h2>Behavioural patterns</h2>
  <table>
    <thead><tr><th>Situation</th><th>Accuracy</th><th>95% range</th><th>Blunders</th><th>Moves</th></tr></thead>
    <tbody>${behaviourRows}</tbody>
  </table>
  <p class="muted">Measured over ${artifact.behaviour?.movesGraded ?? 0} of their own moves across ${artifact.behaviour?.gamesScanned ?? 0} games. These are patterns in how they have played, not claims about what they think or feel — a gap smaller than the ranges shown is not yet a real difference. Buckets under ${artifact.behaviour?.minSamples ?? 25} moves are omitted.</p>`
      : ""
  }

  <h2>Their weakest positions</h2>
  <table>
    <thead><tr><th>Line</th><th>They play</th><th>Accuracy</th><th>Clock (s)</th><th>Freq</th></tr></thead>
    <tbody>${weaknessRows}</tbody>
  </table>

  <h2>Mined novelties</h2>
  <table>
    <thead><tr><th>Line</th><th>Move</th><th>Eval</th><th>Human share</th></tr></thead>
    <tbody>${noveltyRows}</tbody>
  </table>

  <h2>Transposition bypasses</h2>
  <table>
    <thead><tr><th>Bypass move-order</th><th>Their usual move-order</th></tr></thead>
    <tbody>${transpositionRows}</tbody>
  </table>

  <p class="footnote">
    Generated by Kamath Chess Academy. Positions evaluated with Stockfish 18; human move
    popularity from the Lichess Opening Explorer. Games are recency-weighted, so recent
    form counts most. ${htmlEscape(clockNote)} Every line above comes from that analysis
    — nothing is invented.
  </p>
</body>
</html>`;
}

/** Render the dossier HTML to a PDF buffer. */
export async function renderDossierPdf(
  artifact: ProfileArtifact,
  lines: RepertoireLine[],
  narrative: string,
): Promise<Buffer> {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(renderDossierHtml(artifact, lines, narrative), { waitUntil: "load" });
    return Buffer.from(await page.pdf({ format: "A4" }));
  } finally {
    await browser.close();
  }
}
