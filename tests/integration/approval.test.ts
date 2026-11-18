import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { test } from "node:test";
import { like } from "drizzle-orm";
import express from "express";
import { db } from "../../src/db/index.js";
import {
  auditLogs,
  payments,
  staffUsers,
} from "../../src/db/schema.js";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import {
  cleanTestFixtures,
  findAuditRowsForPayment,
  findCheckoutById,
  findOrdersForCheckout,
  findPaymentBySessionId,
  insertCheckoutFixture,
} from "../helpers/db.js";

// The staff config validates JWT_SECRET at import time and exits the process if
// it is missing or short. Force a test value here, before any staff module is
// imported, so the suite can never sign with a real key.
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-chars";

const { hashPassword } = await import("../../src/modules/staff/password.js");
const { staffRouter } = await import("../../src/modules/staff/routes.js");
const { signStaffToken } = await import("../../src/modules/staff/token.js");
const { isApprovalKeyConflict } = await import(
  "../../src/modules/staff/approval.js"
);

const EMAIL_PREFIX = "test-staff-";
const PASSWORD = "correct-horse-battery";
const MINUTE_MS = 60 * 1000;

type Role = "admin" | "agent";
type PaymentStatus = "succeeded" | "review_required" | "order_created";

interface Json {
  [key: string]: unknown;
}

function newEmail(): string {
  return `${EMAIL_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 12)}@example.test`;
}

async function createStaff(role: Role): Promise<{ id: string; token: string }> {
  const [row] = await db
    .insert(staffUsers)
    .values({
      email: newEmail(),
      name: "Test Staff",
      passwordHash: await hashPassword(PASSWORD),
      role,
      active: true,
    })
    .returning({ id: staffUsers.id });

  if (!row) {
    throw new Error("Could not insert the staff fixture");
  }

  return { id: row.id, token: await signStaffToken(row.id) };
}

async function cleanStaff(): Promise<void> {
  await db.delete(staffUsers).where(like(staffUsers.email, `${EMAIL_PREFIX}%`));
}

interface PaymentFixture {
  paymentId: string;
  checkoutId: string;
  sessionId: string;
  amountCents: number;
}

async function createPayment(input: {
  status: PaymentStatus;
  amountCents?: number;
  createdAt?: Date;
  reviewReasons?: readonly string[];
}): Promise<PaymentFixture> {
  const createdAt = input.createdAt ?? new Date();
  const amountCents = input.amountCents ?? 10000;

  const checkout = await insertCheckoutFixture({
    status: input.status === "succeeded" ? "open" : "expired",
    expiresAt: new Date(createdAt.getTime() - 60 * MINUTE_MS),
    amountCents,
    currency: "USD",
    createdAt,
  });

  const [payment] = await db
    .insert(payments)
    .values({
      pendingCheckoutId: checkout.id,
      stripeSessionId: checkout.sessionId,
      amountCents: checkout.amountCents,
      currency: "USD",
      paymentMethodType: "card",
      status: input.status,
      paidAt: createdAt,
      createdAt,
    })
    .returning({ id: payments.id });

  if (!payment) {
    throw new Error("Could not insert the payment fixture");
  }

  if (input.reviewReasons && input.reviewReasons.length > 0) {
    await db.insert(auditLogs).values({
      actorType: "system",
      action: "payment.review_required",
      entityType: "payment",
      entityId: payment.id,
      metadata: {
        previous_status: "succeeded",
        new_status: "review_required",
        reason: input.reviewReasons,
      },
    });
  }

  return {
    paymentId: payment.id,
    checkoutId: checkout.id,
    sessionId: checkout.sessionId,
    amountCents: checkout.amountCents,
  };
}

const app = express();

app.use(express.json());
app.use("/api/staff", staffRouter);
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
    throw new Error("Approval test server did not bind a port");
  }

  server = started;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function call(
  method: "GET" | "POST",
  path: string,
  options: {
    token?: string;
    idempotencyKey?: string;
    body?: unknown;
  } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};

  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  if (options.idempotencyKey !== undefined) {
    headers["idempotency-key"] = options.idempotencyKey;
  }

  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();

  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Json) : {},
  };
}

function approve(
  paymentId: string,
  token: string | undefined,
  idempotencyKey: string | undefined,
  body?: unknown,
) {
  return call("POST", `/api/staff/payments/${paymentId}/approve`, {
    token,
    idempotencyKey,
    body,
  });
}

function list(query: string, token: string | undefined) {
  return call("GET", `/api/staff/payments${query}`, { token });
}

function newKey(): string {
  return `test-approval-${randomUUID()}`;
}

const tests: Array<Promise<void>> = [
  test("admin approves a review_required payment: 200, one order, audit reason array", async () => {
    const admin = await createStaff("admin");
    const fixture = await createPayment({
      status: "review_required",
      reviewReasons: ["late_payment", "amount_mismatch"],
    });
    const key = newKey();

    const result = await approve(fixture.paymentId, admin.token, key, {
      note: "Within the documented grace policy",
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.paymentId, fixture.paymentId);
    assert.equal(typeof result.body.orderId, "string");
    assert.match(String(result.body.orderNumber), /^VISA-\d{4}-\d{6}$/);
    assert.equal(result.body.created, true);

    const payment = await findPaymentBySessionId(fixture.sessionId);

    assert.ok(payment);
    assert.equal(payment.status, "order_created");
    assert.equal(payment.approvedBy, admin.id);
    assert.ok(payment.approvedAt instanceof Date);
    assert.equal(payment.approvalIdempotencyKey, key);

    const orders = await findOrdersForCheckout(fixture.checkoutId);

    assert.equal(orders.length, 1);
    assert.equal(orders[0].id, result.body.orderId);
    assert.equal(orders[0].orderNumber, result.body.orderNumber);
    assert.equal(orders[0].amountCents, fixture.amountCents);

    // Approval does not change the checkout: it stays expired.
    const checkout = await findCheckoutById(fixture.checkoutId);

    assert.ok(checkout);
    assert.equal(checkout.status, "expired");

    const auditRows = await findAuditRowsForPayment(fixture.paymentId);
    const approvedRows = auditRows.filter(
      (row) => row.action === "payment.approved",
    );

    assert.equal(approvedRows.length, 1);

    const audit = approvedRows[0];
    const metadata = audit.metadata as Record<string, unknown>;

    assert.equal(audit.actorType, "staff");
    assert.equal(audit.actorId, admin.id);
    assert.equal(audit.entityType, "payment");
    assert.equal(audit.entityId, fixture.paymentId);
    assert.equal(metadata.previous_status, "review_required");
    assert.equal(metadata.new_status, "order_created");
    assert.deepEqual(metadata.reason, ["late_payment", "amount_mismatch"]);
    assert.equal(metadata.note, "Within the documented grace policy");
    assert.equal(metadata.idempotency_key, key);
  }),

  test("agent gets 403 on approve and nothing changes", async () => {
    const agent = await createStaff("agent");
    const fixture = await createPayment({ status: "review_required" });

    const result = await approve(fixture.paymentId, agent.token, newKey());

    assert.equal(result.status, 403);
    assert.equal(result.body.error, "Forbidden");

    const payment = await findPaymentBySessionId(fixture.sessionId);

    assert.ok(payment);
    assert.equal(payment.status, "review_required");
    assert.equal(await findOrdersForCheckout(fixture.checkoutId).then((rows) => rows.length), 0);
  }),

  test("no token gets 401 on approve and list", async () => {
    const fixture = await createPayment({ status: "review_required" });

    const approveResult = await approve(fixture.paymentId, undefined, newKey());

    assert.equal(approveResult.status, 401);

    const listResult = await list("", undefined);

    assert.equal(listResult.status, 401);

    const payment = await findPaymentBySessionId(fixture.sessionId);

    assert.ok(payment);
    assert.equal(payment.status, "review_required");
  }),

  test("missing, blank, or too-short Idempotency-Key is a 400", async () => {
    const admin = await createStaff("admin");
    const fixture = await createPayment({ status: "review_required" });

    const missing = await approve(fixture.paymentId, admin.token, undefined);
    const blank = await approve(fixture.paymentId, admin.token, "        ");
    const tooShort = await approve(fixture.paymentId, admin.token, "short");

    for (const result of [missing, blank, tooShort]) {
      assert.equal(result.status, 400);
      assert.equal(result.body.code, "validation_error");
    }

    const payment = await findPaymentBySessionId(fixture.sessionId);

    assert.ok(payment);
    assert.equal(payment.status, "review_required");
    assert.equal(payment.approvalIdempotencyKey, null);
  }),

  test("approving twice with the same key returns the original result and one order", async () => {
    const admin = await createStaff("admin");
    const fixture = await createPayment({
      status: "review_required",
      reviewReasons: ["late_payment"],
    });
    const key = newKey();

    const first = await approve(fixture.paymentId, admin.token, key);

    assert.equal(first.status, 200);
    assert.equal(first.body.created, true);

    const second = await approve(fixture.paymentId, admin.token, key);

    assert.equal(second.status, 200);
    assert.equal(second.body.paymentId, first.body.paymentId);
    assert.equal(second.body.orderId, first.body.orderId);
    assert.equal(second.body.orderNumber, first.body.orderNumber);
    assert.equal(second.body.created, false);

    const orders = await findOrdersForCheckout(fixture.checkoutId);

    assert.equal(orders.length, 1);

    const auditRows = await findAuditRowsForPayment(fixture.paymentId);

    assert.equal(
      auditRows.filter((row) => row.action === "payment.approved").length,
      1,
    );
  }),

  test("a different key on the same payment is a 409", async () => {
    const admin = await createStaff("admin");
    const fixture = await createPayment({ status: "review_required" });
    const firstKey = newKey();

    assert.equal((await approve(fixture.paymentId, admin.token, firstKey)).status, 200);

    const other = await approve(fixture.paymentId, admin.token, newKey());

    assert.equal(other.status, 409);
    assert.equal(other.body.error, "Payment has already been approved");
    assert.equal((await findOrdersForCheckout(fixture.checkoutId)).length, 1);

    const payment = await findPaymentBySessionId(fixture.sessionId);

    assert.ok(payment);
    assert.equal(payment.approvalIdempotencyKey, firstKey);
  }),

  test("approving a succeeded payment is a 409", async () => {
    const admin = await createStaff("admin");
    const fixture = await createPayment({ status: "succeeded" });

    const result = await approve(fixture.paymentId, admin.token, newKey());

    assert.equal(result.status, 409);
    assert.equal(result.body.error, "Payment is not awaiting review");

    const payment = await findPaymentBySessionId(fixture.sessionId);

    assert.ok(payment);
    assert.equal(payment.status, "succeeded");
    assert.equal(payment.approvedBy, null);
  }),

  test("an unknown payment id is a 404", async () => {
    const admin = await createStaff("admin");

    const result = await approve(randomUUID(), admin.token, newKey());

    assert.equal(result.status, 404);
    assert.equal(result.body.error, "Payment not found");
  }),

  test("a non-uuid payment id is a 400", async () => {
    const admin = await createStaff("admin");

    const result = await approve("not-a-uuid", admin.token, newKey());

    assert.equal(result.status, 400);
    assert.equal(result.body.code, "validation_error");
  }),

  test("a duplicate key on a different payment is a 409, never a 500", async () => {
    const admin = await createStaff("admin");
    const first = await createPayment({ status: "review_required" });
    const second = await createPayment({ status: "review_required" });
    const key = newKey();

    assert.equal((await approve(first.paymentId, admin.token, key)).status, 200);

    const duplicate = await approve(second.paymentId, admin.token, key);

    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error, "Idempotency-Key already used");

    const payment = await findPaymentBySessionId(second.sessionId);

    assert.ok(payment);
    assert.equal(payment.status, "review_required");
    assert.equal(payment.approvalIdempotencyKey, null);
    assert.equal((await findOrdersForCheckout(second.checkoutId)).length, 0);
  }),

  test("list is filtered by status for both admin and agent", async () => {
    const admin = await createStaff("admin");
    const agent = await createStaff("agent");
    const review = await createPayment({ status: "review_required" });
    const succeeded = await createPayment({ status: "succeeded" });

    for (const token of [admin.token, agent.token]) {
      const filtered = await list(
        "?status=review_required&limit=100",
        token,
      );

      assert.equal(filtered.status, 200);

      const rows = filtered.body.payments as Array<Record<string, unknown>>;

      assert.ok(rows.length > 0);

      for (const row of rows) {
        assert.equal(row.status, "review_required");
        assert.equal(typeof row.reference, "string");
        assert.equal(typeof row.pendingCheckoutId, "string");
      }

      assert.ok(rows.some((row) => row.id === review.paymentId));
      assert.equal(filtered.body.total, rows.length);

      const succeededRows = await list("?status=succeeded&limit=100", token);
      const succeededPage = succeededRows.body.payments as Array<
        Record<string, unknown>
      >;

      assert.equal(succeededRows.status, 200);
      assert.ok(succeededPage.every((row) => row.status === "succeeded"));
      assert.ok(succeededPage.some((row) => row.id === succeeded.paymentId));
    }
  }),

  test("list pagination, ordering, total, and query bounds", async () => {
    const admin = await createStaff("admin");
    const now = Date.now();
    const older = await createPayment({
      status: "review_required",
      createdAt: new Date(now),
    });
    const newer = await createPayment({
      status: "review_required",
      createdAt: new Date(now + MINUTE_MS),
    });

    const all = await list("?status=review_required&limit=100", admin.token);

    assert.equal(all.status, 200);

    const allRows = all.body.payments as Array<Record<string, unknown>>;

    assert.equal(all.body.limit, 100);
    assert.equal(all.body.offset, 0);
    assert.equal(all.body.total, allRows.length);

    const olderIndex = allRows.findIndex((row) => row.id === older.paymentId);
    const newerIndex = allRows.findIndex((row) => row.id === newer.paymentId);

    assert.ok(olderIndex >= 0);
    assert.ok(newerIndex >= 0);
    assert.ok(newerIndex < olderIndex, "newest row is first");

    const firstPage = await list(
      "?status=review_required&limit=1&offset=0",
      admin.token,
    );
    const firstRows = firstPage.body.payments as Array<Record<string, unknown>>;

    assert.equal(firstPage.body.limit, 1);
    assert.equal(firstPage.body.offset, 0);
    assert.equal(firstPage.body.total, all.body.total);
    assert.equal(firstRows.length, 1);
    assert.equal(firstRows[0]?.id, allRows[0]?.id);

    const secondPage = await list(
      "?status=review_required&limit=1&offset=1",
      admin.token,
    );
    const secondRows = secondPage.body.payments as Array<Record<string, unknown>>;

    assert.equal(secondPage.body.offset, 1);
    assert.equal(secondRows.length, 1);
    assert.equal(secondRows[0]?.id, allRows[1]?.id);

    const defaults = await list("", admin.token);

    assert.equal(defaults.status, 200);
    assert.equal(defaults.body.limit, 25);
    assert.equal(defaults.body.offset, 0);

    for (const query of ["?limit=0", "?limit=101", "?offset=-1", "?status=bogus"]) {
      const invalid = await list(query, admin.token);

      assert.equal(invalid.status, 400, `expected 400 for ${query}`);
      assert.equal(invalid.body.code, "validation_error");
    }
  }),

  test("isApprovalKeyConflict matches only the approval-key index", () => {
    // A different unique index is not an approval-key conflict.
    assert.equal(
      isApprovalKeyConflict({
        code: "23505",
        constraint: "orders_order_number_uq",
      }),
      false,
    );

    // The approval index is, by constraint name...
    assert.equal(
      isApprovalKeyConflict({
        code: "23505",
        constraint: "payments_approval_idempotency_key_uq",
      }),
      true,
    );

    // ...or by the message Postgres builds from it.
    assert.equal(
      isApprovalKeyConflict({
        code: "23505",
        message:
          'duplicate key value violates unique constraint "payments_approval_idempotency_key_uq"',
      }),
      true,
    );

    // A bare 23505 without the index name is no longer assumed to be approval.
    assert.equal(isApprovalKeyConflict({ code: "23505" }), false);

    // drizzle wraps the driver error, so the cause chain is still followed.
    assert.equal(
      isApprovalKeyConflict({
        code: "DRIZZLE_QUERY_ERROR",
        cause: {
          code: "23505",
          constraint: "payments_approval_idempotency_key_uq",
        },
      }),
      true,
    );
  }),
];

export const suiteTests: Array<Promise<void>> = [
  ...tests,
  // Runs after every test above has settled: fixtures in FK order, staff rows
  // last (payments.approved_by is ON DELETE RESTRICT), then close the port.
  Promise.allSettled(tests).then(async () => {
    await cleanTestFixtures();
    await cleanStaff();

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
