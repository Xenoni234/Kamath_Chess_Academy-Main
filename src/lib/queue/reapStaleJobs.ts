/**
 * Fail background jobs that were killed with the process that was running them.
 *
 * Every job here already guards itself with a `Promise.race` timeout — 30 minutes
 * for a dossier, 15 for an opening repertoire. Those catch a job that *hangs*.
 * They cannot catch a job that *dies*, because the timer dies with it.
 *
 * And dying is the common case. When `QUEUE_REDIS_URL` is unset the enqueue
 * helpers fall back to `setImmediate`, so jobs run inside the web server itself.
 * Every deploy, crash, or `npm run dev` restart during a job leaves its row saying
 * `processing` with nothing left to finish it. The row never changes again: the
 * dossier list shows "PROFILING" forever, the user waits, and there is no error
 * anywhere because nothing failed — the process simply stopped existing.
 *
 * That happened here: two dossiers sat at `processing` for sixteen hours across a
 * day of server restarts.
 *
 * So this runs at boot and marks anything that has been `processing` longer than
 * any job is allowed to take as `failed`. A stale row is then honestly stale, the
 * UI shows a failure, and the user can regenerate — which is the recovery path
 * these features already have.
 *
 * The cutoff is deliberately well past the longest job timeout. A row younger
 * than that might belong to a job the *previous* process is still running (during
 * an overlapping restart), and failing a live job would be worse than leaving a
 * dead one.
 */
import { db } from "@/lib/db";

/** Longest any job may legitimately take (30 min for a dossier) plus headroom. */
export const STALE_AFTER_MS = 45 * 60 * 1000;

export type ReapResult = {
  profiles: number;
  reports: number;
  openings: number;
};

export async function reapStaleJobs(now: Date = new Date()): Promise<ReapResult> {
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);

  // `updatedAt` rather than `createdAt`: a job that made progress and then died
  // should be measured from its last sign of life, not from when it was queued.
  const [profiles, reports, openings] = await Promise.all([
    db.opponentProfile.updateMany({
      where: { status: "processing", updatedAt: { lt: cutoff } },
      data: { status: "failed" },
    }),
    db.gameReport.updateMany({
      where: { status: "processing", updatedAt: { lt: cutoff } },
      data: { status: "failed" },
    }),
    db.openingRepertoire.updateMany({
      where: { status: "processing", updatedAt: { lt: cutoff } },
      data: { status: "failed" },
    }),
  ]);

  const result = { profiles: profiles.count, reports: reports.count, openings: openings.count };
  const total = result.profiles + result.reports + result.openings;

  if (total > 0) {
    console.warn(
      `[reaper] failed ${total} job(s) abandoned by a previous process ` +
        `(dossiers ${result.profiles}, reports ${result.reports}, openings ${result.openings}). ` +
        `Set QUEUE_REDIS_URL and run the worker to make jobs survive a restart.`,
    );
  }

  return result;
}
