/**
 * Build the bundled opening dataset for the Opening Trainer (Phase 5).
 *
 * Reads the public lichess-org/chess-openings TSVs (a.tsv..e.tsv, CC0) that were
 * downloaded into src/lib/opening/data/, parses each opening's movetext into a
 * SAN + UCI move list and its resulting FEN, and writes a single openings.json
 * the runtime loads once. Nothing here touches the database or the network.
 *
 *   npx tsx scripts/importOpenings.ts
 *
 * Re-run whenever the TSVs are refreshed. The output is committed so production
 * needs neither the TSVs nor this script.
 */
import fs from "node:fs";
import path from "node:path";
import { buildLineFromPgn } from "../src/lib/engine/analysis";

const DATA_DIR = path.join(process.cwd(), "src", "lib", "opening", "data");
const TSV_FILES = ["a.tsv", "b.tsv", "c.tsv", "d.tsv", "e.tsv"];
const OUT_FILE = path.join(DATA_DIR, "openings.json");

/** One opening from the dataset, resolved to concrete moves + position. */
export type OpeningEntry = {
  eco: string;
  name: string;
  /** SAN move-order from the start position. */
  san: string[];
  /** UCI move-order from the start position (the stable matching key). */
  uci: string[];
  /** Ply depth of the named position. */
  ply: number;
  /** Full FEN of the resulting position. */
  fen: string;
  /** 4-field FEN (placement/stm/castling/ep) — transposition key, no clocks. */
  epd: string;
};

function epdOf(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

function main() {
  const entries: OpeningEntry[] = [];
  let skipped = 0;

  for (const file of TSV_FILES) {
    const full = path.join(DATA_DIR, file);
    if (!fs.existsSync(full)) {
      console.error(`Missing ${full} — download the lichess-org/chess-openings TSVs first.`);
      process.exit(1);
    }
    const lines = fs.readFileSync(full, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const [eco, name, pgn] = line.split("\t");
      if (!eco || !name || !pgn) continue;
      if (eco === "eco" && name === "name") continue; // header row

      const parsed = buildLineFromPgn(pgn);
      if (!parsed || parsed.nodes.length === 0) {
        skipped++;
        continue;
      }
      const { nodes } = parsed;
      const fen = nodes[nodes.length - 1].fen;
      entries.push({
        eco: eco.trim(),
        name: name.trim(),
        san: nodes.map((n) => n.san),
        uci: nodes.map((n) => n.uci),
        ply: nodes.length,
        fen,
        epd: epdOf(fen),
      });
    }
  }

  // Deterministic order: by ply (shallowest = broadest families first) then name.
  entries.sort((a, b) => a.ply - b.ply || a.name.localeCompare(b.name));

  fs.writeFileSync(OUT_FILE, JSON.stringify(entries));
  console.log(`Wrote ${entries.length} openings to ${OUT_FILE} (${skipped} unparseable rows skipped).`);
}

main();
