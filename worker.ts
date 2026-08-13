/**
 * Standalone BullMQ worker process.
 *
 *   npm run worker      →  npx tsx --env-file=.env.local worker.ts
 *
 * Requires QUEUE_REDIS_URL pointing at the dedicated TCP Redis. Run this
 * alongside `npm run dev` / `npm start` so queued jobs (reports, invoices) are
 * processed durably. Without QUEUE_REDIS_URL it exits after a warning and the
 * web server falls back to running jobs inline.
 */
import { startWorkers } from "@/lib/queue/worker";

startWorkers();
