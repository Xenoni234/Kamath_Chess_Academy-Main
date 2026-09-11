/**
 * Runs once when the Next server starts.
 *
 * This is where startup work belongs rather than `server.mjs`: that file is
 * loaded by Node directly, so it cannot resolve the `@/` path alias or anything
 * that imports it. Code here goes through the bundler like the rest of the app.
 */
export async function register() {
  // Only in the Node runtime — the edge runtime has no database.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Fail any background job abandoned by the process that ran before this one.
  // Without QUEUE_REDIS_URL those jobs run inside this server, so a restart
  // mid-job leaves its row saying `processing` with nothing left to finish it.
  const { reapStaleJobs } = await import("@/lib/queue/reapStaleJobs");
  await reapStaleJobs().catch((error) => console.error("[reaper] could not run:", error));
}
