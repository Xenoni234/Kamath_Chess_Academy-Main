import { Queue, type ConnectionOptions } from "bullmq";
import { getQueueConnection, queueEnabled } from "./connection";
import { runReportJob, type ReportJobData } from "@/lib/reports/runReportJob";
import { runProfileJob } from "@/lib/second/runProfileJob";
import type { ProfileJobData } from "@/lib/second/types";

export const REPORT_QUEUE = "kca:reports";
export const INVOICE_QUEUE = "kca:invoices";
export const PROFILE_QUEUE = "kca:profiles";

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

let profileQueue: Queue | null = null;

function getProfileQueue(): Queue | null {
  if (!queueEnabled()) return null;
  if (!profileQueue) {
    profileQueue = new Queue(PROFILE_QUEUE, { connection: bullmqConnection() });
  }
  return profileQueue;
}

/**
 * Enqueue an opponent-profiling job. Same durable-with-inline-fallback contract
 * as enqueueReport: with QUEUE_REDIS_URL it survives restarts; without it, the
 * job runs inline (fire-and-forget) so the feature works in dev.
 */
export async function enqueueProfile(data: ProfileJobData): Promise<void> {
  const queue = getProfileQueue();
  if (queue) {
    await queue.add("profile", data, { removeOnComplete: true, removeOnFail: 50 });
    return;
  }
  setImmediate(() => void runProfileJob(data));
}
