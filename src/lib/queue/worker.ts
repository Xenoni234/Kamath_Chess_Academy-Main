import { Worker, type ConnectionOptions } from "bullmq";
import { getQueueConnection } from "./connection";
import { REPORT_QUEUE, PROFILE_QUEUE } from "./queues";
import { runReportJob, type ReportJobData } from "@/lib/reports/runReportJob";
import { runProfileJob } from "@/lib/second/runProfileJob";
import type { ProfileJobData } from "@/lib/second/types";

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
    { connection: connection as unknown as ConnectionOptions },
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
    { connection: connection as unknown as ConnectionOptions },
  );

  profileWorker.on("failed", (job, err) =>
    console.error(`[worker] profile job ${job?.id ?? "?"} failed:`, err.message),
  );
  profileWorker.on("completed", (job) => console.log(`[worker] profile job ${job.id} completed`));

  // Invoice worker is registered here in Track D.
  console.log(`[worker] started — processing queues: ${REPORT_QUEUE}, ${PROFILE_QUEUE}`);
}
