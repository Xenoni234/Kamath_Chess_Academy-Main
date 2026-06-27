import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";

export async function GET() {
  const checks = {
    db: false,
    redis: false,
    timestamp: new Date().toISOString(),
  };

  try {
    await db.$queryRaw`SELECT 1`;
    checks.db = true;
  } catch (error) {
    console.error("Health DB check failed:", error);
  }

  try {
    await redis.ping();
    checks.redis = true;
  } catch (error) {
    console.error("Health Redis check failed:", error);
  }

  return NextResponse.json({
    status: checks.db && checks.redis ? "ok" : "degraded",
    checks,
  });
}
