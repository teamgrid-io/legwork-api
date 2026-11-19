import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { pool } from "../../src/db/pool.js";
import {
  auditLogs,
  orderEvents,
  orders,
  payments,
  pendingCheckouts,
  stripeWebhookEvents,
  visaProducts,
} from "../../src/db/schema.js";

export const TEST_REFERENCE_PREFIX = "TEST-";
export const TEST_SESSION_PREFIX = "TEST-cs-";
export const TEST_EVENT_PREFIX = "evt_test_";

const LEGWORK_FEE_CENTS = 2000;

export interface CheckoutFixtureInput {
  status: "open" | "paid" | "expired";
  expiresAt: Date;
  amountCents: number;
  currency: string;
  createdAt: Date;
}

export interface CheckoutFixture {
  id: string;
  reference: string;
  sessionId: string;
  amountCents: number;
  currency: string;
  expiresAt: Date;
  status: string;
}

interface ParentIds {
  visaProductId: string;
  passportCountryId: string;
}

let cachedParents: ParentIds | null = null;

/**
 * pending_checkouts has NOT NULL FKs to visa_products and countries. The test
 * database is seeded, so reuse one existing product rather than inventing
 * parent rows the cleanup would also have to own.
 */
async function getParentIds(): Promise<ParentIds> {
  if (cachedParents) {
    return cachedParents;
  }

  const [product] = await db
    .select({
      id: visaProducts.id,
      destinationCountryId: visaProducts.destinationCountryId,
    })
    .from(visaProducts)
    .limit(1);

  if (!product) {
    throw new Error(
      "legwork_test has no visa_products row; seed the test database first",
    );
  }

  cachedParents = {
    visaProductId: product.id,
    passportCountryId: product.destinationCountryId,
  };

  return cachedParents;
}

export async function insertCheckoutFixture(
  input: CheckoutFixtureInput,
): Promise<CheckoutFixture> {
  const parents = await getParentIds();
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const reference = `${TEST_REFERENCE_PREFIX}${suffix}`;
  const sessionId = `${TEST_SESSION_PREFIX}${suffix}`;

  const [row] = await db
    .insert(pendingCheckouts)
    .values({
      reference,
      visaProductId: parents.visaProductId,
      passportCountryId: parents.passportCountryId,
      travelDate: "2027-06-01",
      travellerCount: 1,
      travellers: [
        {
          first_name: "Test",
          surname: "Traveller",
          gender: "female",
          maritalStatus: "single",
        },
      ],
      contactEmail: "fixture@example.test",
      formVersion: 1,
      governmentFeeCents: Math.max(input.amountCents - LEGWORK_FEE_CENTS, 0),
      legworkFeeCents: LEGWORK_FEE_CENTS,
      amountCents: input.amountCents,
      currency: input.currency,
      status: input.status,
      stripeSessionId: sessionId,
      expiresAt: input.expiresAt,
      createdAt: input.createdAt,
    })
    .returning({
      id: pendingCheckouts.id,
      reference: pendingCheckouts.reference,
      stripeSessionId: pendingCheckouts.stripeSessionId,
      amountCents: pendingCheckouts.amountCents,
      currency: pendingCheckouts.currency,
      expiresAt: pendingCheckouts.expiresAt,
      status: pendingCheckouts.status,
    });

  if (!row || !row.stripeSessionId) {
    throw new Error("Could not insert the pending_checkouts fixture");
  }

  return {
    id: row.id,
    reference: row.reference,
    sessionId: row.stripeSessionId,
    amountCents: row.amountCents,
    currency: row.currency,
    expiresAt: row.expiresAt,
    status: row.status,
  };
}

export interface WebhookEventFixtureInput {
  status: "processing" | "processed" | "failed";
  attemptCount: number;
  receivedAt: Date;
  eventType?: string;
  lastError?: string | null;
}

export function newTestEventId(): string {
  return `${TEST_EVENT_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export async function insertWebhookEventFixture(
  eventId: string,
  input: WebhookEventFixtureInput,
): Promise<void> {
  await db.insert(stripeWebhookEvents).values({
    eventId,
    eventType: input.eventType ?? "checkout.session.completed",
    status: input.status,
    attemptCount: input.attemptCount,
    lastError: input.lastError ?? null,
    receivedAt: input.receivedAt,
    processedAt: input.status === "processed" ? input.receivedAt : null,
  });
}

/**
 * Delete only this suite's fixtures, in FK order. Any pre-existing rows in
 * legwork_test are untouched.
 */
export async function cleanTestFixtures(): Promise<void> {
  // Captured before the payments rows disappear, so the audit rows can still be
  // addressed by payment id afterwards.
  const paymentRows = await db
    .select({ id: payments.id })
    .from(payments)
    .where(like(payments.stripeSessionId, `${TEST_SESSION_PREFIX}%`));

  const paymentIds = paymentRows.map((row) => row.id);

  const testCheckoutIds = db
    .select({ id: pendingCheckouts.id })
    .from(pendingCheckouts)
    .where(like(pendingCheckouts.reference, `${TEST_REFERENCE_PREFIX}%`));

  const testOrderIds = db
    .select({ id: orders.id })
    .from(orders)
    .where(inArray(orders.pendingCheckoutId, testCheckoutIds));

  await db.delete(orderEvents).where(inArray(orderEvents.orderId, testOrderIds));

  await db
    .delete(orders)
    .where(inArray(orders.pendingCheckoutId, testCheckoutIds));

  await db
    .delete(payments)
    .where(like(payments.stripeSessionId, `${TEST_SESSION_PREFIX}%`));

  await db
    .delete(pendingCheckouts)
    .where(like(pendingCheckouts.reference, `${TEST_REFERENCE_PREFIX}%`));

  await db
    .delete(stripeWebhookEvents)
    .where(like(stripeWebhookEvents.eventId, `${TEST_EVENT_PREFIX}%`));

  if (paymentIds.length > 0) {
    await db
      .delete(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "payment"),
          inArray(auditLogs.entityId, paymentIds),
        ),
      );
  }
}

export async function findWebhookEvent(eventId: string) {
  const [row] = await db
    .select()
    .from(stripeWebhookEvents)
    .where(eq(stripeWebhookEvents.eventId, eventId))
    .limit(1);

  return row ?? null;
}

export async function findPaymentBySessionId(sessionId: string) {
  const [row] = await db
    .select()
    .from(payments)
    .where(eq(payments.stripeSessionId, sessionId))
    .limit(1);

  return row ?? null;
}

export async function findCheckoutById(checkoutId: string) {
  const [row] = await db
    .select()
    .from(pendingCheckouts)
    .where(eq(pendingCheckouts.id, checkoutId))
    .limit(1);

  return row ?? null;
}

export async function findOrdersForCheckout(checkoutId: string) {
  return db
    .select()
    .from(orders)
    .where(eq(orders.pendingCheckoutId, checkoutId));
}

export async function findAuditRowsForPayment(paymentId: string) {
  return db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.entityType, "payment"),
        eq(auditLogs.entityId, paymentId),
      ),
    );
}

export async function closePool(): Promise<void> {
  await pool.end();
}
