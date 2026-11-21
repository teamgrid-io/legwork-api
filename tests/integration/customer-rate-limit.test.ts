import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { and, eq, inArray, like } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { auditLogs, customers } from "../../src/db/schema.js";
import { resetCustomerRateLimiter } from "../../src/modules/customer/rate-limit.js";
import { hashPassword } from "../../src/modules/staff/password.js";
import { getBaseUrl } from "../helpers/server.js";

const EMAIL_PREFIX = "test-customer-rate-limit-";
const PASSWORD = "customer-password-123";
const WRONG_PASSWORD = "definitely-not-the-password";

const RATE_LIMITED_BODY = {
  error: "Too many attempts",
  code: "rate_limited",
};

function newEmail(): string {
  return `${EMAIL_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 12)}@example.test`;
}

interface CustomerOptions {
  /** An activated account can log in; an unactivated one cannot. */
  activated?: boolean;
}

async function createCustomer(
  email = newEmail(),
  options: CustomerOptions = {},
): Promise<string> {
  const activated = options.activated ?? true;

  await db.insert(customers).values({
    email,
    name: "Rate Limit Customer",
    phone: "+15550100000",
    passwordHash: activated ? await hashPassword(PASSWORD) : null,
    activatedAt: activated ? new Date() : null,
  });

  return email;
}

/** Remove only this address's rows, in FK order. */
async function cleanup(email: string): Promise<void> {
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.email, email));
  const ids = rows.map((row) => row.id);

  if (ids.length === 0) {
    return;
  }

  await db
    .delete(auditLogs)
    .where(
      and(
        eq(auditLogs.entityType, "customer"),
        inArray(auditLogs.entityId, ids),
      ),
    );
  await db.delete(customers).where(inArray(customers.id, ids));
}

/** Remove fixtures that a previous failed run may have left behind. */
async function cleanStaleFixtures(): Promise<void> {
  const stale = await db
    .select({ email: customers.email })
    .from(customers)
    .where(like(customers.email, `${EMAIL_PREFIX}%`));

  for (const row of stale) {
    await cleanup(row.email);
  }
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
  retryAfter: string | null;
}

async function postJson(
  path: string,
  body: unknown,
): Promise<JsonResponse> {
  const response = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await response.text();

  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    retryAfter: response.headers.get("retry-after"),
  };
}

function assertRetryAfter(value: string | null): void {
  assert.equal(typeof value, "string");

  const seconds = Number(value);

  assert.ok(Number.isInteger(seconds));
  assert.ok(seconds >= 1 && seconds <= 900, `unexpected Retry-After: ${value}`);
}

function assertRateLimited(result: JsonResponse): void {
  assert.equal(result.status, 429);
  assert.deepEqual(result.body, RATE_LIMITED_BODY);
  assertRetryAfter(result.retryAfter);
}

async function login(email: string, password: string): Promise<JsonResponse> {
  return postJson("/api/v1/auth/login", { email, password });
}

const tests: Array<Promise<void>> = [
  test("5 wrong-password logins return 401 and the 6th returns 429 with Retry-After", async () => {
    resetCustomerRateLimiter();

    const email = await createCustomer();

    try {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const result = await login(email, WRONG_PASSWORD);

        assert.equal(result.status, 401, `attempt ${attempt} should be 401`);
        assert.equal(result.body.error, "Invalid credentials");
      }

      assertRateLimited(await login(email, WRONG_PASSWORD));
    } finally {
      await cleanup(email);
    }
  }),

  test("the 429 body is identical for a known and an unknown email", async () => {
    resetCustomerRateLimiter();

    const known = await createCustomer();

    try {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        assert.equal((await login(known, WRONG_PASSWORD)).status, 401);
      }

      const knownBlocked = await login(known, WRONG_PASSWORD);

      assertRateLimited(knownBlocked);

      // Start the unknown-email run from zero so only the address differs.
      resetCustomerRateLimiter();

      const unknown = newEmail();

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        assert.equal((await login(unknown, WRONG_PASSWORD)).status, 401);
      }

      const unknownBlocked = await login(unknown, WRONG_PASSWORD);

      assertRateLimited(unknownBlocked);
      assert.deepEqual(knownBlocked.body, unknownBlocked.body);
    } finally {
      await cleanup(known);
    }
  }),

  test("a correct-password attempt also counts toward the email bucket", async () => {
    resetCustomerRateLimiter();

    const email = await createCustomer();

    try {
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        assert.equal((await login(email, WRONG_PASSWORD)).status, 401);
      }

      const correct = await login(email, PASSWORD);

      assert.equal(correct.status, 200);
      assert.equal(typeof correct.body.token, "string");

      // The success above was the fifth counted attempt, so this is the sixth.
      assertRateLimited(await login(email, PASSWORD));
    } finally {
      await cleanup(email);
    }
  }),

  test("20 attempts from one IP across different emails: the 21st is 429", async () => {
    resetCustomerRateLimiter();

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const result = await login(newEmail(), WRONG_PASSWORD);

      assert.equal(result.status, 401, `attempt ${attempt} should be 401`);
    }

    assertRateLimited(await login(newEmail(), WRONG_PASSWORD));
  }),

  test("activation: 5 bad tokens return 400 and the 6th returns 429", async () => {
    resetCustomerRateLimiter();

    const token = `TEST-invalid-${randomUUID().replace(/-/g, "")}`;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await postJson("/api/v1/auth/activate", {
        token,
        password: PASSWORD,
      });

      assert.equal(result.status, 400, `attempt ${attempt} should be 400`);
      assert.equal(result.body.error, "Invalid or expired activation link");
    }

    assertRateLimited(
      await postJson("/api/v1/auth/activate", {
        token,
        password: PASSWORD,
      }),
    );
  }),

  test("resend-activation: 5 attempts then the 6th is 429 for known and unknown emails", async () => {
    resetCustomerRateLimiter();

    const known = await createCustomer();

    try {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const result = await postJson("/api/v1/auth/resend-activation", {
          email: known,
        });

        assert.equal(result.status, 200, `attempt ${attempt} should be 200`);
      }

      const knownBlocked = await postJson("/api/v1/auth/resend-activation", {
        email: known,
      });

      assertRateLimited(knownBlocked);

      resetCustomerRateLimiter();

      const unknown = newEmail();

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        assert.equal(
          (
            await postJson("/api/v1/auth/resend-activation", {
              email: unknown,
            })
          ).status,
          200,
        );
      }

      const unknownBlocked = await postJson(
        "/api/v1/auth/resend-activation",
        { email: unknown },
      );

      assertRateLimited(unknownBlocked);
      assert.deepEqual(knownBlocked.body, unknownBlocked.body);
    } finally {
      await cleanup(known);
    }
  }),
];

export const suiteTests: Array<Promise<void>> = [
  ...tests,
  // Runs after every test above has settled. Only this suite's fixtures and
  // in-memory windows are touched.
  Promise.allSettled(tests).then(async () => {
    await cleanStaleFixtures();
    resetCustomerRateLimiter();
  }),
];
