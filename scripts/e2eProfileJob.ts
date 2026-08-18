/**
 * End-to-end run of the real profiling job, including persistence.
 *
 * Creates a throwaway dossier with two accounts across both sites, runs
 * runProfileJob exactly as the worker would, asserts what landed in Postgres,
 * then deletes everything it made (including the Neo4j subgraph).
 *
 * This is the only path that exercises artifact persistence, the repertoire
 * plan row, PDF file output and the notification — everything else had been
 * verified only in memory.
 *
 * Run: npx tsx --env-file=.env.local scripts/e2eProfileJob.ts
 */
import { existsSync, statSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { runProfileJob } from "../src/lib/second/runProfileJob";
import { deleteProfileGraph } from "../src/lib/second/graph";
import type { ProfileArtifact } from "../src/lib/second/types";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const ACCOUNTS = [
  { handle: "Hikaru", source: "CHESSCOM" as const },
  { handle: "DrNykterstein", source: "LICHESS" as const },
];

function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function main() {
  const user = await db.user.findFirst({ select: { id: true, username: true } });
  if (!user) throw new Error("no user to own the test dossier");
  console.log(`owner: ${user.username}\n`);

  const profile = await db.opponentProfile.create({
    data: {
      requestedById: user.id,
      handle: ACCOUNTS[0].handle,
      source: ACCOUNTS[0].source,
      colorToPlay: "white",
      status: "pending",
      accounts: { create: ACCOUNTS.map((a, position) => ({ ...a, position })) },
    },
    select: { id: true },
  });
  console.log(`created test profile ${profile.id}`);

  const started = Date.now();
  try {
    await runProfileJob({
      profileId: profile.id,
      requestedById: user.id,
      accounts: ACCOUNTS,
      handle: ACCOUNTS[0].handle,
      source: ACCOUNTS[0].source,
      colorToPlay: "white",
    });
    console.log(`job finished in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

    const row = await db.opponentProfile.findUnique({
      where: { id: profile.id },
      include: { repertoires: true, accounts: true },
    });
    if (!row) throw new Error("profile vanished");

    const a = row.artifact as unknown as ProfileArtifact | null;
    let ok = true;
    console.log("persistence:");
    ok = check("status complete", row.status === "complete", row.status) && ok;
    ok = check("accounts rows", row.accounts.length === 2, `${row.accounts.length}`) && ok;
    ok = check("artifact stored", Boolean(a)) && ok;
    ok = check("summary stored", Boolean(row.summary), `${row.summary?.length ?? 0} chars`) && ok;
    ok = check("repertoire plan row", row.repertoires.length === 1) && ok;

    if (a) {
      console.log("artifact contents:");
      ok = check("accounts provenance", (a.accounts?.length ?? 0) === 2) && ok;
      ok = check("ingest diagnostics", Boolean(a.ingest), JSON.stringify(a.ingest)) && ok;
      ok = check("recencyReferenceAt", Boolean(a.recencyReferenceAt), a.recencyReferenceAt ?? "") && ok;
      ok = check("clockBasis", Boolean(a.clockBasis), JSON.stringify(a.clockBasis)) && ok;
      ok = check("tactical profile", Boolean(a.tactical),
        `${a.tactical?.motifs.length ?? 0} motifs over ${a.tactical?.gamesScanned ?? 0} games`) && ok;
      ok = check("behavioural profile", Boolean(a.behaviour),
        `${a.behaviour?.movesGraded ?? 0} moves, clocks=${a.behaviour?.clockDataAvailable}`) && ok;
      ok = check("transpositions ran", a.graphUsed, `graphUsed=${a.graphUsed} reason=${a.graphSkipReason ?? "-"}`) && ok;
      ok = check("ratingSummary carries handles",
        a.ratingSummary.every((r) => Boolean(r.handle)), `${a.ratingSummary.length} entries`) && ok;
    }

    const pdf = row.repertoires[0]?.pdfUrl;
    ok = check("PDF on disk", Boolean(pdf && existsSync(pdf)),
      pdf && existsSync(pdf) ? `${(statSync(pdf).size / 1024).toFixed(0)} KB` : "missing") && ok;

    const notes = await db.notification.count({
      where: { userId: user.id, createdAt: { gte: new Date(started) } },
    });
    ok = check("notification created", notes > 0, `${notes}`) && ok;

    console.log(`\n${ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
  } finally {
    await deleteProfileGraph(profile.id).catch(() => {});
    await db.opponentProfile.delete({ where: { id: profile.id } }).catch(() => {});
    console.log(`\ncleaned up test profile ${profile.id}`);
    await db.$disconnect();
  }
  process.exit(0);
}

main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
