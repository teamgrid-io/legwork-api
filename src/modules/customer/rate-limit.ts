import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const WINDOW_MS = 15 * 60 * 1000;
export const IP_LIMIT = 20;
export const EMAIL_LIMIT = 5;

interface WindowEntry {
  count: number;
  windowStart: number;
}

export interface RateLimitStore {
  /** Charge one attempt to `key` and return the window it now belongs to. */
  increment(
    key: string,
    windowMs: number,
  ): { count: number; windowStart: number };
  /** Test hook: drop every window so the next attempt starts from zero. */
  reset(): void;
}

/**
 * Per-process store. It resets on restart and is not shared between instances;
 * that is acceptable for the MVP but must be replaced by a shared store (Redis
 * or the database) before more than one API instance runs.
 *
 * Each route supplies its own namespace, so the login, activation, and resend
 * counters never collide with each other or with the staff limiter.
 */
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

  // A pending cleanup tick must not keep the process (or a test run) alive.
  cleanupTimer.unref();

  return {
    increment(key, windowMs) {
      const now = Date.now();
      const entry = windows.get(key);

      if (!entry || now - entry.windowStart >= windowMs) {
        const fresh = { count: 1, windowStart: now };
        windows.set(key, fresh);
        return fresh;
      }

      entry.count += 1;
      return entry;
    },
    reset() {
      windows.clear();
    },
  };
}

/** Separate from the staff store on purpose: the counters never interact. */
export const customerRateLimitStore = createInMemoryRateLimitStore();

/** Read without validating: only a string email is counted, exactly as sent. */
function emailFromBody(req: Request): string | null {
  const body: unknown = req.body;

  if (typeof body !== "object" || body === null) {
    return null;
  }

  const email = (body as { email?: unknown }).email;

  if (typeof email !== "string") {
    return null;
  }

  return email.trim().toLowerCase();
}

/**
 * The activation body has no email, so the identity bucket falls back to the
 * link token. Hashing keeps a real activation token out of the in-memory map
 * while still grouping repeated attempts for the same link.
 */
function activationIdentity(req: Request): string | null {
  const email = emailFromBody(req);

  if (email !== null) {
    return email;
  }

  const body: unknown = req.body;

  if (typeof body !== "object" || body === null) {
    return null;
  }

  const token = (body as { token?: unknown }).token;

  if (typeof token !== "string" || token.length === 0) {
    return null;
  }

  return createHash("sha256").update(token).digest("hex");
}

type IdentityReader = (req: Request) => string | null;

function reject(res: Response, entry: WindowEntry): void {
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((entry.windowStart + WINDOW_MS - Date.now()) / 1000),
  );

  // Fixed line only: never the email, the IP, or which bucket applied.
  console.warn("Customer auth rate limit reached");

  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({
    error: "Too many attempts",
    code: "rate_limited",
  });
}

/**
 * Both limits are counted and checked before the controller runs, so a
 * locked-out request never hashes a password or looks up a token. Every attempt
 * is charged, including a successful one and one that is about to be rejected,
 * and neither a success nor a failure resets the window.
 */
function rateLimit(
  route: string,
  identityOf: IdentityReader,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const ipEntry = customerRateLimitStore.increment(
      `${route}:ip:${req.ip ?? "unknown"}`,
      WINDOW_MS,
    );
    const identity = identityOf(req);
    const identityEntry =
      identity === null
        ? null
        : customerRateLimitStore.increment(
            `${route}:email:${identity}`,
            WINDOW_MS,
          );

    if (ipEntry.count > IP_LIMIT) {
      reject(res, ipEntry);
      return;
    }

    if (identityEntry !== null && identityEntry.count > EMAIL_LIMIT) {
      reject(res, identityEntry);
      return;
    }

    next();
  };
}

// Counts every attempt for now. In the Redis step, change this bucket to count failed attempts only.
export const loginRateLimiter = rateLimit("login", emailFromBody);

export const activationRateLimiter = rateLimit(
  "activate",
  activationIdentity,
);
export const resendActivationRateLimiter = rateLimit("resend", emailFromBody);

/** Test hook: drop every customer auth window. */
export function resetCustomerRateLimiter(): void {
  customerRateLimitStore.reset();
}
