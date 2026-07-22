import { PrismaClient, Prisma } from "@prisma/client";

/**
 * Error codes that mean "the database wasn't reachable *this instant*" rather
 * than "your query is wrong". On Neon's serverless tier the compute suspends
 * after inactivity, so the first request after idle can fail while it wakes up.
 *   P1001 - can't reach database server
 *   P1002 - server reached but timed out
 *   P1008 - operation timed out
 *   P1017 - server closed the connection
 *   P2024 - timed out fetching a connection from the pool
 */
const RETRYABLE = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);

const MAX_RETRIES = 6;
const BASE_DELAY_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return RETRYABLE.has(err.code);
  }
  if (err instanceof Error && err.message.includes("connection pool")) {
    return true;
  }
  // Cold-start init failures surface as this class before a code is assigned.
  return err instanceof Prisma.PrismaClientInitializationError;
}

export const prisma = new PrismaClient();

/**
 * Transparently retry transient connection failures (Neon cold starts, dropped
 * pooled connections) with exponential backoff + jitter. Real query errors are
 * re-thrown immediately on the first attempt.
 */
prisma.$use(async (params, next) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await next(params);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === MAX_RETRIES) throw err;
      const delay =
        BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 200);
      await sleep(delay);
    }
  }
  throw lastErr;
});

/**
 * Warm the connection pool on boot, retrying while the serverless DB wakes up,
 * so the very first real request doesn't eat the cold-start latency.
 */
export async function connectWithRetry(): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch (err) {
      if (!isRetryable(err) || attempt === MAX_RETRIES) {
        return; // don't crash the server — the query-level retry still guards requests
      }
      const delay = BASE_DELAY_MS * 2 ** attempt;
      await sleep(delay);
    }
  }
}

/**
 * Keep the serverless compute awake. Neon's free tier suspends after a few
 * minutes idle, and the first request after that fails with P1001; a cheap
 * periodic ping keeps it warm so no user (or demo) ever hits a cold start.
 * `unref()` so it never holds the process open on its own.
 */
const KEEPALIVE_MS = 60_000;
const keepAlive = setInterval(() => {
  prisma.$queryRaw`SELECT 1`.catch(() => {
    /* a missed ping is harmless — the query-level retry covers real requests */
  });
}, KEEPALIVE_MS);
keepAlive.unref?.();

// Warm the pool immediately on import.
void connectWithRetry();
