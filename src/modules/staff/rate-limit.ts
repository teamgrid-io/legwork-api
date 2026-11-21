import type { NextFunction, Request, Response } from "express";
import { Redis } from "ioredis";
import { config } from "../../config.js";

export const WINDOW_MS = 15 * 60 * 1000;
export const IP_LIMIT = 20;
export const EMAIL_LIMIT = 5;

interface WindowEntry {
  count: number;
  windowStart: number;
}

export interface RateLimitEntry extends WindowEntry {
  remainingMs: number;
}

export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<RateLimitEntry>;
  reset(): Promise<void>;
}

const incrementScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`;

const redisConnection =
  config.rateLimitStore === "redis"
    ? new Redis(config.redisUrl, { maxRetriesPerRequest: 1 })
    : null;

redisConnection?.on("error", () => {
  console.error("Rate limit Redis connection error");
});

export function createInMemoryRateLimitStore(): RateLimitStore {
  const windows = new Map<string, WindowEntry>();
  const cleanupTimer = setInterval(() => {
    const now = Date.now();

    for (const [key, entry] of windows) {
      if (now - entry.windowStart >= WINDOW_MS) {
        windows.delete(key);
      }
    }
  }, WINDOW_MS);
  cleanupTimer.unref();

  return {
    async increment(key, windowMs) {
      const now = Date.now();
      const entry = windows.get(key);

      if (!entry || now - entry.windowStart >= windowMs) {
        const fresh = { count: 1, windowStart: now };
        windows.set(key, fresh);
        return { ...fresh, remainingMs: windowMs };
      }

      entry.count += 1;
      return {
        ...entry,
        remainingMs: Math.max(0, entry.windowStart + windowMs - Date.now()),
      };
    },
    async reset() {
      windows.clear();
    },
  };
}

export function createRedisRateLimitStore(prefix: string): RateLimitStore {
  if (!redisConnection) {
    throw new Error("Redis rate limit store is not configured");
  }

  const redisKey = (key: string): string => `${prefix}${key}`;

  return {
    async increment(key, windowMs) {
      const result = (await redisConnection.eval(
        incrementScript,
        1,
        redisKey(key),
        String(windowMs),
      )) as [number | string, number | string];
      const count = Number(result[0]);
      const remainingMs = Math.max(0, Number(result[1]));
      const observedAt = Date.now();
      const windowStart = observedAt - Math.max(0, windowMs - remainingMs);

      return { count, windowStart, remainingMs };
    },
    async reset() {
      let cursor = "0";

      do {
        const [nextCursor, keys] = await redisConnection.scan(
          cursor,
          "MATCH",
          `${prefix}*`,
          "COUNT",
          "500",
        );

        if (keys.length > 0) {
          await redisConnection.del(...keys);
        }

        cursor = nextCursor;
      } while (cursor !== "0");
    },
  };
}

export function createRateLimitStore(prefix: string): RateLimitStore {
  return config.rateLimitStore === "redis"
    ? createRedisRateLimitStore(prefix)
    : createInMemoryRateLimitStore();
}

export async function closeRateLimitRedisConnection(): Promise<void> {
  if (!redisConnection) {
    return;
  }

  try {
    await redisConnection.quit();
  } catch {
    redisConnection.disconnect();
  }
}

const staffRateLimitStore = createRateLimitStore("rl:staff:");

function emailFromBody(req: Request): string | null {
  const body: unknown = req.body;

  if (typeof body !== "object" || body === null) {
    return null;
  }

  const email = (body as { email?: unknown }).email;

  return typeof email === "string" ? email.trim().toLowerCase() : null;
}

function reject(res: Response, entry: RateLimitEntry): void {
  const retryAfterSeconds = Math.ceil(entry.remainingMs / 1000);

  console.warn("Staff login rate limit reached");
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({
    error: "Too many login attempts",
    code: "rate_limited",
  });
}

/** Both buckets are charged before the login controller runs. */
export function createStaffLoginRateLimiter(
  store: RateLimitStore = staffRateLimitStore,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    const ipEntry = await store.increment(
      `ip:${req.ip ?? "unknown"}`,
      WINDOW_MS,
    );
    const email = emailFromBody(req);
    const emailEntry =
      email === null
        ? null
        : await store.increment(`email:${email}`, WINDOW_MS);

    if (ipEntry.count > IP_LIMIT) {
      reject(res, ipEntry);
      return;
    }

    if (emailEntry !== null && emailEntry.count > EMAIL_LIMIT) {
      reject(res, emailEntry);
      return;
    }

    next();
  };
}

export const loginRateLimiter = createStaffLoginRateLimiter();

/** Test hook: delete only keys under the staff rate-limit prefix. */
export function resetRateLimiter(): Promise<void> {
  return staffRateLimitStore.reset();
}
