/**
 * Track F5 — turn a profile artifact into a recommended repertoire.
 *
 * Selection is deterministic and engine-grounded: lines come from the
 * opponent's own weak positions, the transposition bypasses that reach them,
 * and the mined novelties. Claude (or the template fallback) then *annotates*
 * them — it never invents the moves, so the repertoire stays chess-safe
 * whichever AI provider is active.
 */
import type { ProfileArtifact, RepertoireLine } from "@/lib/second/types";

/** Recommended lines, strongest targeting first. */
export function buildRepertoireLines(artifact: ProfileArtifact): RepertoireLine[] {
  const lines: RepertoireLine[] = [];
  const seen = new Set<string>();

  const push = (line: RepertoireLine) => {
    const key = line.moves.join(" ");
    if (!key || seen.has(key)) return;
    seen.add(key);
    lines.push(line);
  };

  // 1. Novelties — a sound move they have almost certainly never faced.
  for (const n of artifact.novelties.slice(0, 4)) {
    const share = n.explorerShare === null ? "rarely played" : `played in ${(n.explorerShare * 100).toFixed(1)}% of human games`;
    push({
      moves: [...n.line, n.move],
      rationale: `${n.move} is engine-approved (${n.evalCp ?? 0}cp) but ${share} — it takes ${artifact.handle} out of book immediately.`,
      tag: "novelty",
    });
  }

  // 2. Transposition bypasses — reach a weak position via a move-order they don't prep.
  for (const t of artifact.transpositions.slice(0, 3)) {
    push({ moves: t.bypass, rationale: t.note, tag: "transposition" });
  }

  // 3. Straight weakness targeting — steer into what they play badly.
  for (const w of artifact.weaknesses.slice(0, 6)) {
    const clock = w.avgClockSpent !== null ? `, and burns ~${w.avgClockSpent}s deciding` : "";
    push({
      moves: w.line,
      rationale: `From here ${artifact.handle} usually plays ${w.theirMove}, which scores only ${w.accuracy}% accuracy${clock}. Steer the game here.`,
      tag: "weakness",
    });
  }

  // 4. Their main line, so the student knows what to expect.
  for (const s of artifact.trieSummary.slice(0, 2)) {
    push({
      moves: s.line,
      rationale: `Their most frequent line (scoring ${s.scorePct}% for them). Know it — expect to be met with this.`,
      tag: "mainline",
    });
  }

  return lines.slice(0, 12);
}

/** Compact, promptable description of the opponent for the AI layer. */
export function describeArtifact(artifact: ProfileArtifact, lines: RepertoireLine[]): string {
  const ratings = artifact.ratingSummary
    .filter((r) => r.rating)
    .map((r) => `${r.format} ${r.rating}`)
    .join(", ");

  const weaknesses = artifact.weaknesses
    .slice(0, 6)
    .map(
      (w, i) =>
        `${i + 1}. After ${w.line.join(" ") || "(start)"} they play ${w.theirMove} — accuracy ${w.accuracy}%${
          w.avgClockSpent !== null ? `, ~${w.avgClockSpent}s spent` : ""
        } (seen ~${w.weightedFrequency}x)`,
    )
    .join("\n");

  const novelties = artifact.novelties
    .slice(0, 4)
    .map(
      (n) =>
        `- ${n.move} after ${n.line.join(" ") || "(start)"} — ${n.evalCp ?? 0}cp, human share ${
          n.explorerShare === null ? "unknown" : `${(n.explorerShare * 100).toFixed(1)}%`
        }`,
    )
    .join("\n");

  const transpositions = artifact.transpositions
    .slice(0, 3)
    .map((t) => `- ${t.bypass.join(" ")} (instead of their usual ${t.mainLine.join(" ")})`)
    .join("\n");

  const recommended = lines
    .map((l, i) => `${i + 1}. [${l.tag}] ${l.moves.join(" ")} — ${l.rationale}`)
    .join("\n");

  return `Opponent: ${artifact.handle} (${artifact.source})
Ratings: ${ratings || "unknown"}
Games analysed: ${artifact.gamesAnalyzed}
We play: ${artifact.colorToPlay}

Their most-played lines:
${artifact.trieSummary
  .slice(0, 6)
  .map((s) => `- ${s.line.join(" ")} (weight ${s.weightedCount}, scores ${s.scorePct}% for them)`)
  .join("\n") || "- none detected"}

Their weakest recurring positions (Stockfish-graded):
${weaknesses || "- none clearly identified"}

Mined novelties (engine-strong, human-rare):
${novelties || "- none found"}

Transposition bypasses:
${transpositions || "- none found"}

Recommended lines to annotate:
${recommended || "- none"}`;
}
