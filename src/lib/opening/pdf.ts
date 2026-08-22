/**
 * Render an opening repertoire to PDF — the same Puppeteer HTML->PDF approach as
 * the dossier (second/pdf.ts). Written to /tmp, which is ephemeral and
 * per-instance, so the download route may legitimately 404 for older repertoires
 * (regenerating restores it).
 */
import puppeteer from "puppeteer";
import type { OpeningArtifact, RepertoireLine } from "./types";

function htmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[char];
  });
}

function evalLabel(cp: number | null | undefined, color: "white" | "black"): string {
  if (cp === null || cp === undefined) return "";
  const ours = color === "white" ? cp : -cp;
  const pawns = (ours / 100).toFixed(2);
  return `${ours > 0 ? "+" : ""}${pawns}`;
}

export function renderOpeningHtml(
  artifact: OpeningArtifact,
  lines: RepertoireLine[],
  guide: string,
): string {
  const title = `${artifact.name}${artifact.eco ? ` (${artifact.eco})` : ""}`;
  const guideParas = guide
    .split(/\n\n+/)
    .map((p) => `<p>${htmlEscape(p).replace(/\n/g, "<br/>")}</p>`)
    .join("\n");

  const variations = artifact.variations
    .map((v, i) => {
      const line = lines[i];
      const moves = line?.moves ?? v.line;
      const isBest = artifact.bestLineIndex === i;
      const bookNote =
        line?.outOfBookAtPly !== undefined
          ? `<span class="note">popular to move ${Math.ceil(line.outOfBookAtPly / 2)}, then engine</span>`
          : "";
      const ev = line ? evalLabel(line.evalCp, artifact.colorToPlay) : "";
      const tag = v.tag !== "variation" && v.tag !== "mainline" ? `<span class="tag ${v.tag}">${v.tag}</span>` : "";
      return `<li class="${isBest ? "best" : ""}">
        <div class="vhead"><span class="vname">${htmlEscape(v.name)}</span>${tag}${isBest ? '<span class="tag best">engine best</span>' : ""}${ev ? `<span class="eval">${ev}</span>` : ""}</div>
        <div class="moves">${htmlEscape(moves.join(" "))}</div>
        <div class="rationale">${htmlEscape(line?.rationale ?? "")} ${bookNote}</div>
      </li>`;
    })
    .join("\n");

  return `<!doctype html><html><head><meta charset="utf-8"/><style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #16181c; margin: 40px; line-height: 1.5; }
    h1 { font-size: 24px; margin: 0 0 2px; }
    .sub { color: #667; margin-bottom: 24px; font-size: 13px; }
    h2 { font-size: 15px; border-bottom: 2px solid #00838f; padding-bottom: 4px; margin-top: 28px; color: #006064; }
    p { margin: 0 0 10px; }
    ol { padding-left: 0; list-style: none; }
    li { border: 1px solid #e2e5ea; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
    li.best { border-color: #00838f; background: #f0fbfc; }
    .vhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .vname { font-weight: 600; }
    .moves { font-family: "SFMono-Regular", Menlo, monospace; font-size: 12px; margin: 4px 0; color: #22252b; }
    .rationale { font-size: 12px; color: #556; }
    .note { color: #888; font-style: italic; }
    .eval { margin-left: auto; font-family: monospace; font-weight: 600; color: #00838f; }
    .tag { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px; border-radius: 4px; background: #eef; color: #446; }
    .tag.gambit { background: #fff3e0; color: #b45309; }
    .tag.trap { background: #fde8e8; color: #b91c1c; }
    .tag.best { background: #00838f; color: #fff; }
  </style></head><body>
    <h1>${htmlEscape(title)}</h1>
    <div class="sub">Repertoire for ${artifact.colorToPlay} · ${artifact.variations.length} variations · generated ${new Date(artifact.generatedAt).toLocaleDateString()}</div>
    <h2>Coach's guide</h2>
    ${guideParas}
    <h2>Variations</h2>
    <ol>${variations}</ol>
  </body></html>`;
}

/** Render the opening HTML to a PDF buffer. */
export async function renderOpeningPdf(
  artifact: OpeningArtifact,
  lines: RepertoireLine[],
  guide: string,
): Promise<Buffer> {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(renderOpeningHtml(artifact, lines, guide), { waitUntil: "load" });
    return Buffer.from(await page.pdf({ format: "A4" }));
  } finally {
    await browser.close();
  }
}
