import { Worker, type ConnectionOptions } from "bullmq";
import { getQueueConnection } from "./connection";
import { REPORT_QUEUE, PROFILE_QUEUE, OPENING_QUEUE, INVOICE_QUEUE } from "./queues";
import { runReportJob, type ReportJobData } from "@/lib/reports/runReportJob";
import { runProfileJob } from "@/lib/second/runProfileJob";
import { runOpeningJob } from "@/lib/opening/runOpeningJob";
import { runInvoiceJob, type InvoiceJobData } from "@/lib/payments/runInvoiceJob";
import type { ProfileJobData } from "@/lib/second/types";
import type { OpeningJobData } from "@/lib/opening/types";

/**
 * Boot the BullMQ workers. Run from the standalone `worker.ts` entrypoint
 * (`npm run worker`). When QUEUE_REDIS_URL is unset there is nothing to do —
 * the web server runs jobs inline instead (see enqueueReport).
 */
export function startWorkers(): void {
  const connection = getQueueConnection();
  if (!connection) {
    console.warn(
      "[worker] QUEUE_REDIS_URL not set — no workers started. The web server runs jobs inline instead.",
    );
    return;
  }

  const reportWorker = new Worker<ReportJobData>(
    REPORT_QUEUE,
    async (job) => {
      await runReportJob(job.data);
    },
    // See queues.ts — nested-ioredis types differ; runtime-compatible, so cast.
    // concurrency 1: every report spawns a full Chromium for the PDF. Two at once
    // on a 2 GB VPS is an OOM kill, which surfaces as a job stuck in `processing`.
    { connection: connection as unknown as ConnectionOptions, concurrency: 1 },
  );

  reportWorker.on("failed", (job, err) =>
    console.error(`[worker] report job ${job?.id ?? "?"} failed:`, err.message),
  );
  reportWorker.on("completed", (job) => console.log(`[worker] report job ${job.id} completed`));

  const profileWorker = new Worker<ProfileJobData>(
    PROFILE_QUEUE,
    async (job) => {
      await runProfileJob(job.data);
    },
    // concurrency 2: dossiers are Stockfish- and network-bound, and mapWithEngines
    // already fans out internally, so this is about overlapping I/O waits, not CPU.
    { connection: connection as unknown as ConnectionOptions, concurrency: 2 },
  );

  profileWorker.on("failed", (job, err) =>
    console.error(`[worker] profile job ${job?.id ?? "?"} failed:`, err.message),
  );
  profileWorker.on("completed", (job) => console.log(`[worker] profile job ${job.id} completed`));

  const openingWorker = new Worker<OpeningJobData>(
    OPENING_QUEUE,
    async (job) => {
      await runOpeningJob(job.data);
    },
    { connection: connection as unknown as ConnectionOptions, concurrency: 2 },
  );

  openingWorker.on("failed", (job, err) =>
    console.error(`[worker] opening job ${job?.id ?? "?"} failed:`, err.message),
  );
  openingWorker.on("completed", (job) => console.log(`[worker] opening job ${job.id} completed`));

  const invoiceWorker = new Worker<InvoiceJobData>(
    INVOICE_QUEUE,
    async (job) => {
      await runInvoiceJob(job.data);
    },
    // concurrency 1, same Chromium reason as reports.
    { connection: connection as unknown as ConnectionOptions, concurrency: 1 },
  );

  invoiceWorker.on("failed", (job, err) =>
    console.error(`[worker] invoice job ${job?.id ?? "?"} failed:`, err.message),
  );
  invoiceWorker.on("completed", (job) => console.log(`[worker] invoice job ${job.id} completed`));

  // Graceful shutdown. `Worker.close()` stops accepting new jobs and waits for the
  // in-flight one to finish; without this a `docker compose restart` SIGKILLs the
  // process mid-render, leaving a half-written PDF and a row stuck in `processing`
  // forever — the exact symptom DEPLOYMENT.md §14 tells you to look for.
  //
  // The compose `worker` service needs `stop_grace_period: 120s` to match: Docker
  // sends SIGKILL 10 s after SIGTERM by default, which would defeat all of this.
  const workers = [reportWorker, profileWorker, openingWorker, invoiceWorker];
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received — finishing in-flight jobs…`);
    try {
      await Promise.all(workers.map((w) => w.close()));
      await connection.quit();
      console.log("[worker] shut down cleanly");
      process.exit(0);
    } catch (error) {
      console.error("[worker] shutdown failed:", error);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  console.log(
    `[worker] started — processing queues: ${REPORT_QUEUE}, ${PROFILE_QUEUE}, ${OPENING_QUEUE}, ${INVOICE_QUEUE}`,
  );
}
