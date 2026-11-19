import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { test } from "node:test";
import { like } from "drizzle-orm";
import express from "express";
import { db } from "../../src/db/index.js";
import { staffUsers } from "../../src/db/schema.js";
import { errorHandler } from "../../src/middleware/errorHandler.js";

// The staff config validates JWT_SECRET at import time and exits the process if
// it is missing or short. Force a test value here, before any staff module is
// imported, so the suite can never sign with a real key.
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-chars";

const { hashPassword } = await import("../../src/modules/staff/password.js");
const { staffRouter } = await import("../../src/modules/staff/routes.js");
const { resetRateLimiter } = await import(
  "../../src/modules/staff/rate-limit.js"
);

const EMAIL_PREFIX = "test-staff-";
const PASSWORD = "correct-horse-battery";
const WRONG_PASSWORD = "definitely-not-the-password";

interface Json {
  [key: string]: unknown;
}

function newEmail(): string {
  return `${EMAIL_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 12)}@example.test`;
}

async function createStaff(email = newEmail()): Promise<string> {
  await db.insert(staffUsers).values({
    email,
    name: "Rate Limit Staff",
    passwordHash: await hashPassword(PASSWORD),
    role: "admin",
    active: true,
  });

  return email;
}

async function cleanStaff(): Promise<void> {
  await db.delete(staffUsers).where(like(staffUsers.email, `${EMAIL_PREFIX}%`));
}

const app = express();

app.use(express.json());
app.use("/api/v1/staff", staffRouter);
app.use(errorHandler);

let server: Server | null = null;
let baseUrl = "";

{
  const started = app.listen(0, "127.0.0.1");

  await new Promise<void>((resolve, reject) => {
    started.once("listening", () => resolve());
    started.once("error", reject);
  });

  const address = started.address();

  if (address === null || typeof address === "string") {
    throw new Error("Rate limit test server did not bind a port");
  }

  server = started;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

interface LoginResult {
  status: number;
  body: Json;
  retryAfter: string | null;
}

async function postLogin(body: unknown): Promise<LoginResult> {
  const response = await fetch(`${baseUrl}/api/v1/staff/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await response.text();

  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Json) : {},
    retryAfter: response.headers.get("retry-after"),
  };
}

function assertRetryAfter(value: string | null): void {
  assert.equal(typeof value, "string");

  const seconds = Number(value);

  assert.ok(Number.isInteger(seconds));
  assert.ok(seconds >= 1 && seconds <= 900, `unexpected Retry-After: ${value}`);
}

function assertRateLimited(result: LoginResult): void {
  assert.equal(result.status, 429);
  assert.deepEqual(result.body, {
    error: "Too many login attempts",
    code: "rate_limited",
  });
  assertRetryAfter(result.retryAfter);
}

const tests: Array<Promise<void>> = [
  test("5 wrong-password attempts return 401 and the 6th returns 429 with Retry-After", async () => {
    resetRateLimiter();

    const email = await createStaff();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await postLogin({ email, password: WRONG_PASSWORD });

      assert.equal(result.status, 401, `attempt ${attempt} should be 401`);
      assert.equal(result.body.error, "Invalid credentials");
    }

    assertRateLimited(await postLogin({ email, password: WRONG_PASSWORD }));
  }),

  test("the 429 body is identical for an existing and an unknown email", async () => {
    resetRateLimiter();

    const existing = await createStaff();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      assert.equal(
        (await postLogin({ email: existing, password: WRONG_PASSWORD })).status,
        401,
      );
    }

    const existingBlocked = await postLogin({
      email: existing,
      password: WRONG_PASSWORD,
    });

    resetRateLimiter();

    const unknown = newEmail();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      assert.equal(
        (await postLogin({ email: unknown, password: WRONG_PASSWORD })).status,
        401,
      );
    }

    const unknownBlocked = await postLogin({
      email: unknown,
      password: WRONG_PASSWORD,
    });

    assertRateLimited(existingBlocked);
    assertRateLimited(unknownBlocked);
    assert.deepEqual(unknownBlocked.body, existingBlocked.body);
  }),

  test("a different email from the same IP is still allowed", async () => {
    resetRateLimiter();

    const first = newEmail();
    const second = newEmail();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      assert.equal(
        (await postLogin({ email: first, password: WRONG_PASSWORD })).status,
        401,
      );
    }

    assertRateLimited(
      await postLogin({ email: first, password: WRONG_PASSWORD }),
    );

    // Same IP, different email: the email window is independent.
    const allowed = await postLogin({ email: second, password: WRONG_PASSWORD });

    assert.equal(allowed.status, 401);
    assert.equal(allowed.body.error, "Invalid credentials");
  }),

  test("20 attempts from one IP across different emails: the 21st is 429", async () => {
    resetRateLimiter();

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const result = await postLogin({
        email: newEmail(),
        password: WRONG_PASSWORD,
      });

      assert.equal(result.status, 401, `attempt ${attempt} should be 401`);
    }

    assertRateLimited(
      await postLogin({ email: newEmail(), password: WRONG_PASSWORD }),
    );
  }),

  test("resetRateLimiter() allows attempts again", async () => {
    resetRateLimiter();

    const email = newEmail();

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await postLogin({ email, password: WRONG_PASSWORD });
    }

    assertRateLimited(await postLogin({ email, password: WRONG_PASSWORD }));

    resetRateLimiter();

    const allowed = await postLogin({ email, password: WRONG_PASSWORD });

    assert.equal(allowed.status, 401);
    assert.equal(allowed.body.error, "Invalid credentials");
  }),

  test("a malformed body counts against the IP limit and does not crash", async () => {
    resetRateLimiter();

    // No email field at all: only the IP limit applies.
    for (let attempt = 1; attempt <= 19; attempt += 1) {
      const result = await postLogin({});

      assert.equal(result.status, 400, `attempt ${attempt} should be 400`);
      assert.equal(result.body.code, "validation_error");
    }

    // email present but not a string: the email limit is skipped, IP still counts.
    const nonStringEmail = await postLogin({ email: 123, password: "x" });

    assert.equal(nonStringEmail.status, 400);
    assert.equal(nonStringEmail.body.code, "validation_error");

    assertRateLimited(await postLogin({}));
  }),

  test("a correct password is counted too: the 6th is 429", async () => {
    resetRateLimiter();

    const email = await createStaff();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await postLogin({ email, password: PASSWORD });

      assert.equal(result.status, 200, `attempt ${attempt} should be 200`);
      assert.equal(typeof result.body.token, "string");
    }

    assertRateLimited(await postLogin({ email, password: PASSWORD }));
  }),
];

export const suiteTests: Array<Promise<void>> = [
  ...tests,
  // Fixtures and in-memory windows are per suite; drop both, then close the port.
  Promise.allSettled(tests).then(async () => {
    await cleanStaff();
    resetRateLimiter();

    const current = server;

    if (!current) {
      return;
    }

    server = null;
    current.closeAllConnections();

    await new Promise<void>((resolve, reject) => {
      current.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }),
];
