import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

/**
 * The database lives in a different region to most users (Supabase
 * `ap-northeast-1`), so a round trip costs ~150 ms and *opening* a connection
 * costs several of them — TCP, then TLS, then SCRAM auth, before the first
 * query is even sent.
 *
 * `pg-pool` defaults `idleTimeoutMillis` to 10 s. The notification bell polls
 * every 30 s, so with the default every poll — and every human-paced page
 * navigation — found an empty pool and paid the full handshake again, roughly
 * 700-900 ms before doing any work. Holding connections open across those gaps
 * is what removes that cost.
 */
const POOL_CONFIG = {
  connectionString: process.env.DATABASE_URL,
  /** Comfortably longer than the slowest client poll (30 s) plus idle browsing. */
  idleTimeoutMillis: 5 * 60_000,
  /** Supabase's pooler is the real limiter; this just bounds one server instance. */
  max: 10,
  /** Stops NAT/firewall idle-reaping from silently killing held connections. */
  keepAlive: true,
  /** Fail fast rather than hanging a request when the pool cannot hand one out. */
  connectionTimeoutMillis: 10_000,
};

/**
 * Both the client and the pool are memoised. Memoising only the client (as this
 * previously did) still ran `new PrismaPg(...)` on every hot reload, leaking an
 * orphaned `pg.Pool` — and its held connections — per reload in development.
 */
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaAdapter?: PrismaPg;
};

const adapter = (globalForPrisma.prismaAdapter ??= new PrismaPg(POOL_CONFIG));

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
