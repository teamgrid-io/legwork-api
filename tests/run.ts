/**
 * Test entrypoint for the Stripe webhook suites.
 *
 * The guard below runs before any src/ module is imported. That matters twice
 * over: config.ts reads NODE_ENV and the payment variables at import time, and
 * db/pool.ts captures DATABASE_URL at import time. Nothing may touch the
 * database until the target has been proven to be legwork_test.
 *
 * No URL is ever printed, in the guard or anywhere else.
 */

const REQUIRED_DATABASE = "legwork_test";

function refuse(reason: string): never {
  console.error(`Refusing to run webhook tests: ${reason}`);
  process.exit(1);
}

function assertTestDatabase(raw: string | undefined): void {
  if (!raw) {
    refuse("DATABASE_URL is not set");
  }

  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    refuse("DATABASE_URL is not a valid URL");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    refuse("DATABASE_URL must use the postgres or postgresql scheme");
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));

  if (databaseName !== REQUIRED_DATABASE) {
    refuse(`DATABASE_URL must name exactly the ${REQUIRED_DATABASE} database`);
  }
}

assertTestDatabase(process.env.DATABASE_URL);

// Set unconditionally: the suites must never inherit a developer's real values.
process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDER = "stripe";
process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_placeholder";
process.env.ADMIN_PASSWORD = "test-password-only";
process.env.JWT_SECRET = "test-staff-jwt-secret-at-least-32-chars";
process.env.CUSTOMER_JWT_SECRET = "test-customer-jwt-secret-at-least-32-chars";
process.env.PAYMENT_REVIEW_GRACE_SECONDS = "300";

// Also required by config.ts; not secrets, so fixed values are fine.
process.env.WEB_URL = "http://localhost:3000";
process.env.FIELD_ENCRYPTION_KEY = "0".repeat(64);

const { startTestServer, closeTestServer } = await import("./helpers/server.js");
const { cleanTestFixtures } = await import("./helpers/db.js");
const { closePool } = await import("./helpers/db.js");
// Imported up front so the teardown below always has the handle. BullMQ treats
// a caller-supplied ioredis instance as shared and will not close it, so the
// producer connection must be closed here or the process never exits.
const { documentScanQueue, producerConnection } = await import(
  "../src/lib/queue.js"
);

const suitePaths = [
  "./integration/webhook-flow.test.js",
  "./integration/dedupe.test.js",
  "./integration/sweeper.test.js",
  "./integration/submit.test.js",
  "./integration/staff-auth.test.js",
  "./integration/customer-auth.test.js",
  "./integration/read-endpoints.test.js",
  "./integration/ownership.test.js",
  "./integration/approval.test.js",
  "./integration/rate-limit.test.js",
];

let failures = 0;

try {
  await startTestServer();
  await cleanTestFixtures();

  // Imported after the server is listening: each suite registers its tests at
  // import time and hands back the promises, so the runner controls ordering.
  for (const path of suitePaths) {
    const suite = (await import(path)) as {
      suiteTests: Array<Promise<void>>;
    };

    const results = await Promise.allSettled(suite.suiteTests);
    failures += results.filter((result) => result.status === "rejected").length;
  }
} finally {
  await closeTestServer();
  await cleanTestFixtures();
  await closePool();

  // Every test result is already recorded by this point, so teardown failures
  // must not change `failures`. Closing the queue does not close the producer
  // connection (it is shared), so close that explicitly to let Node exit.
  try {
    await documentScanQueue.close();
  } catch (error) {
    console.error(
      `Could not close the document scan queue: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    await producerConnection.quit();
  } catch {
    // quit() fails when the socket is not writable (e.g. Redis was down the
    // whole run); drop it without a graceful handshake instead.
    producerConnection.disconnect();
  }
}

if (failures > 0) {
  console.error(`Webhook tests failed: ${failures} test(s)`);
}

process.exitCode = failures > 0 ? 1 : 0;
