/**
 * End-to-end run of the real opening-trainer job, including persistence.
 *
 * Creates a throwaway OpeningRepertoire row, runs runOpeningJob exactly as the
 * worker would, asserts what landed in Postgres (status, artifact, lines, PDF),
 * then deletes everything it made. This is the only path that exercises artifact
 * persistence, the lines JSON, the PDF file and the DB round-trip together.
 *
 * Run: npx tsx --env-file=.env.local scripts/e2eOpeningJob.ts
 */
import { existsSync, statSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { runOpeningJob } from "../src/lib/opening/runOpeningJob";
import { resolveOpening, openingSlug } from "../src/lib/opening/eco";
import type { OpeningArtifact, RepertoireLine } from "../src/lib/opening/types";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function main() {
  const user = await db.user.findFirst({ select: { id: true } });
  const requestedById = user?.id ?? "no-user"; // notification is best-effort in the job

  const root = resolveOpening("Italian Game");
  if (!root) throw new Error("could not resolve test opening");

  // Use a throwaway slug so we never collide with the real global cache.
  const slug = `__e2e__${Date.now()}:` + openingSlug(root.name, "white");
  const row = await db.openingRepertoire.create({
    data: { slug, name: root.name, eco: root.eco, colorToPlay: "white", status: "pending" },
    select: { id: true },
  });
  console.log(`Created test repertoire ${row.id} (${root.name})`);

  let allPass = true;
  try {
    const t0 = Date.now();
    await runOpeningJob({ repertoireId: row.id, name: root.name, colorToPlay: "white", rootUci: root.uci, requestedById });
    console.log(`Job finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const saved = await db.openingRepertoire.findUnique({ where: { id: row.id } });
    if (!saved) throw new Error("row vanished");

    const artifact = saved.artifact as unknown as OpeningArtifact | null;
    const lines = saved.linesJson as unknown as RepertoireLine[] | null;

    allPass = check("status is complete", saved.status === "complete", saved.status) && allPass;
    allPass = check("artifact persisted", !!artifact, artifact ? `${artifact.variations.length} variations` : "null") && allPass;
    allPass = check("lines persisted", !!lines && lines.length > 0, lines ? `${lines.length} lines` : "null") && allPass;
    allPass = check(
      "every line >= 20 plies",
      !!lines && lines.every((l) => l.moves.length >= 20),
      lines ? `min ${Math.min(...lines.map((l) => l.moves.length))}` : "",
    ) && allPass;
    allPass = check("best line index set", artifact?.bestLineIndex !== null && artifact?.bestLineIndex !== undefined, String(artifact?.bestLineIndex)) && allPass;
    allPass = check("guide (summary) non-empty", !!saved.summary && saved.summary.length > 50, `${saved.summary?.length ?? 0} chars`) && allPass;
    if (saved.pdfUrl) {
      const ok = existsSync(saved.pdfUrl) && statSync(saved.pdfUrl).size > 1000;
      allPass = check("PDF written to disk", ok, saved.pdfUrl) && allPass;
    } else {
      console.log("  WARN  no PDF (puppeteer may be unavailable in this env) — non-fatal");
    }
  } finally {
    // Cleanup.
    const saved = await db.openingRepertoire.findUnique({ where: { id: row.id }, select: { pdfUrl: true } });
    if (saved?.pdfUrl && existsSync(saved.pdfUrl)) {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(saved.pdfUrl);
    }
    await db.openingRepertoire.delete({ where: { id: row.id } }).catch(() => {});
    console.log("Cleaned up test repertoire.");
  }

  console.log(allPass ? "\n✅ ALL PASS" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
