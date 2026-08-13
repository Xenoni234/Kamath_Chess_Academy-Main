import IORedis from "ioredis";

/**
 * Connection for BullMQ. This is a DEDICATED TCP Redis (QUEUE_REDIS_URL),
 * deliberately separate from the app's Upstash REST Redis (`src/lib/redis.ts`,
 * used for game state / matchmaking) — BullMQ needs a real TCP connection that
 * the Upstash REST SDK cannot provide. The two never share an instance.
 */
let connection: IORedis | null = null;

export function queueEnabled(): boolean {
  return Boolean(process.env.QUEUE_REDIS_URL);
}

export function getQueueConnection(): IORedis | null {
  if (!process.env.QUEUE_REDIS_URL) return null;
  if (!connection) {
    connection = new IORedis(process.env.QUEUE_REDIS_URL, {
      // Required by BullMQ workers (blocking commands must not time out).
      maxRetriesPerRequest: null,
    });
    connection.on("error", (err) => console.error("[queue] Redis connection error:", err.message));
  }
  return connection;
}
