import type { NextFunction, Request, Response } from "express";

export const WINDOW_MS = 15 * 60 * 1000;
export const IP_LIMIT = 20;
export const EMAIL_LIMIT = 5;

interface WindowEntry {
  count: number;
  windowStart: number;
}

/**
 * Per-process store. It resets on restart and is not shared between instances;
 * that is acceptable for the MVP but must be replaced by a shared store (Redis
 * or the database) before more than one API instance runs.
 *
 * Keys are namespaced (ip:/email:) so the two limits never collide.
 */
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
 * Read without writing: an entry whose window has passed counts as zero, but it
 * is not stored until the request is actually recorded.
 */
function currentEntry(key: string, now: number): WindowEntry {
  const entry = windows.get(key);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    return { count: 0, windowStart: now };
  }

  return entry;
}

function record(key: string, now: number): void {
  const entry = windows.get(key);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    windows.set(key, { count: 1, windowStart: now });
    return;
  }

  entry.count += 1;
}

function reject(res: Response, entry: WindowEntry, now: number): void {
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000),
  );

  // Fixed line only: never the email or the IP.
  console.warn("Staff login rate limit reached");

  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({
    error: "Too many login attempts",
    code: "rate_limited",
  });
}

/**
 * POST /api/staff/login guard. Both limits must pass before the controller runs,
 * so a locked-out request never reaches scrypt.
 *
 * Every attempt that gets this far is counted, including wrong passwords,
 * unknown emails, inactive accounts, and structurally invalid bodies. A
 * syntactically invalid JSON body is rejected by express.json() before routing
 * and therefore cannot be counted; only the IP limit could apply to it anyway.
 * A successful login is counted too and never resets the window.
 */
export function loginRateLimiter(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const now = Date.now();
  const ipKey = `ip:${req.ip ?? "unknown"}`;
  const ipEntry = currentEntry(ipKey, now);

  if (ipEntry.count >= IP_LIMIT) {
    reject(res, ipEntry, now);
    return;
  }

  const email = emailFromBody(req);
  const emailKey = email === null ? null : `email:${email}`;
  const emailEntry = emailKey === null ? null : currentEntry(emailKey, now);

  if (emailEntry !== null && emailEntry.count >= EMAIL_LIMIT) {
    reject(res, emailEntry, now);
    return;
  }

  record(ipKey, now);

  if (emailKey !== null) {
    record(emailKey, now);
  }

  next();
}

/** Test hook: drop every window so the next attempt starts from zero. */
export function resetRateLimiter(): void {
  windows.clear();
}
