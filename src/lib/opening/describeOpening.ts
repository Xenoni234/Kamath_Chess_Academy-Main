/**
 * Render an OpeningArtifact + extended lines into the plain-text block handed to
 * the AI coach (see claude.ts `generateOpeningGuide`). The coach only annotates
 * what is here — it never invents moves — so every line, eval, and out-of-book ply
 * the guide can mention must appear in this text.
 *
 * Analogue of second/repertoire.ts `describeArtifact`, framed for teaching an
 * opening rather than beating an opponent.
 */
import type { OpeningArtifact, RepertoireLine } from "./types";

/** Centipawns (White POV) → a short "+0.4 (White)" style string from our side. */
function evalLabel(cp: number | null | undefined, color: "white" | "black"): string {
  if (cp === null || cp === undefined) return "unclear";
  const ours = color === "white" ? cp : -cp;
  const pawns = (ours / 100).toFixed(2);
  const sign = ours > 0 ? "+" : "";
  return `${sign}${pawns} for you`;
}

export function describeOpening(artifact: OpeningArtifact, lines: RepertoireLine[]): string {
  const parts: string[] = [];

  parts.push(
    `Opening: ${artifact.name}${artifact.eco ? ` (ECO ${artifact.eco})` : ""}. ` +
      `You play ${artifact.colorToPlay}. Defining moves: ${artifact.rootMoves.join(" ") || "(start)"}.`,
  );

  if (artifact.bestLineIndex !== null && lines[artifact.bestLineIndex]) {
    const b = lines[artifact.bestLineIndex];
    parts.push(
      `Engine's strongest line for you: ${b.moves.join(" ")} — final evaluation ${evalLabel(b.evalCp, artifact.colorToPlay)}.`,
    );
  }

  const lineText = artifact.variations
    .map((v, i) => {
      const line = lines[i];
      const moves = line?.moves.join(" ") ?? v.line.join(" ");
      const book =
        line?.outOfBookAtPly !== undefined
          ? ` [popular human moves to move ${Math.ceil(line.outOfBookAtPly / 2)}, then engine]`
          : "";
      const ev = line ? `, eval ${evalLabel(line.evalCp, artifact.colorToPlay)}` : "";
      const tag = v.tag !== "variation" && v.tag !== "mainline" ? ` (${v.tag})` : "";
      return `${i + 1}. ${v.name}${tag}: ${moves}${book}${ev}`;
    })
    .join("\n");

  parts.push(`Variations covered (${artifact.variations.length}), each extended to about 15 moves:\n${lineText}`);

  if (!artifact.explorerCoverage.hasToken) {
    parts.push(
      "Note: population statistics were unavailable, so the branch choices lean on the engine and opening theory rather than move popularity.",
    );
  }

  return parts.join("\n\n");
}
