import { Queue, type ConnectionOptions } from "bullmq";
import { getQueueConnection, queueEnabled } from "./connection";
import { runReportJob, type ReportJobData } from "@/lib/reports/runReportJob";

export const REPORT_QUEUE = "kca:reports";
export const INVOICE_QUEUE = "kca:invoices";

// BullMQ ships its own nested ioredis; passing our top-level ioredis instance is
// runtime-compatible but the two package copies have distinct types, so we cast
// at this single boundary.
function bullmqConnection(): ConnectionOptions {
  return getQueueConnection() as unknown as ConnectionOptions;
}

let reportQueue: Queue | null = null;

function getReportQueue(): Queue | null {
  if (!queueEnabled()) return null;
  if (!reportQueue) {
    reportQueue = new Queue(REPORT_QUEUE, { connection: bullmqConnection() });
  }
  return reportQueue;
}

/**
 * Enqueue a report job onto the durable queue. If QUEUE_REDIS_URL isn't set yet
 * (queue not provisioned), fall back to running it inline (fire-and-forget) so
 * reports keep working in dev — identical to the old behaviour. Once the queue
 * Redis is live, the same call routes through BullMQ and survives restarts.
 */
export async function enqueueReport(data: ReportJobData): Promise<void> {
  const queue = getReportQueue();
  if (queue) {
    await queue.add("generate", data, { removeOnComplete: true, removeOnFail: 50 });
    return;
  }
  setImmediate(() => void runReportJob(data));
}
