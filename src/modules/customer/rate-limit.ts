import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import {
  createRateLimitStore,
  type RateLimitEntry,
} from "../staff/rate-limit.js";

export const WINDOW_MS = 15 * 60 * 1000;
export const IP_LIMIT = 20;
export const EMAIL_LIMIT = 5;

const customerRateLimitStore = createRateLimitStore("rl:customer:");

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
 * link token. Hashing keeps a real activation token out of Redis keys.
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

function reject(res: Response, entry: RateLimitEntry): void {
  const retryAfterSeconds = Math.ceil(entry.remainingMs / 1000);

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
 * locked-out request never hashes a password or looks up a token. Every
 * attempt is charged, including a successful one and one that is about to be
 * rejected, and neither a success nor a failure resets the window.
 */
function rateLimit(
  route: string,
  identityOf: IdentityReader,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    const ipEntry = await customerRateLimitStore.increment(
      `${route}:ip:${req.ip ?? "unknown"}`,
      WINDOW_MS,
    );
    const identity = identityOf(req);
    const identityEntry =
      identity === null
        ? null
        : await customerRateLimitStore.increment(
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

// Counts every attempt for now. The Redis store is in use; change this bucket to count failed attempts only.
export const loginRateLimiter = rateLimit("login", emailFromBody);

export const activationRateLimiter = rateLimit(
  "activate",
  activationIdentity,
);
export const resendActivationRateLimiter = rateLimit("resend", emailFromBody);

/** Test hook: delete only keys under the customer rate-limit prefix. */
export function resetCustomerRateLimiter(): Promise<void> {
  return customerRateLimitStore.reset();
}
