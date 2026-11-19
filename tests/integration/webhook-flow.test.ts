import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { postStripeEvent } from "../helpers/server.js";
import {
  buildCheckoutCompletedEvent,
  signStripePayload,
} from "../helpers/stripe-sign.js";
import {
  findAuditRowsForPayment,
  findCheckoutById,
  findOrdersForCheckout,
  findPaymentBySessionId,
  findWebhookEvent,
  insertCheckoutFixture,
  newTestEventId,
} from "../helpers/db.js";

const MINUTE_MS = 60 * 1000;

export const suiteTests: Array<Promise<void>> = [
  test("unknown session: 200, event processed with unknown_session, no payment row", async () => {
    const eventId = newTestEventId();
    const sessionId = `TEST-cs-unknown-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const payload = buildCheckoutCompletedEvent({
      eventId,
      sessionId,
      created: new Date(),
      amountTotal: 10000,
      paymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
    });

    const response = await postStripeEvent(
      payload,
      signStripePayload(payload),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { received: true });

    const event = await findWebhookEvent(eventId);

    assert.ok(event);
    assert.equal(event.status, "processed");
    assert.equal(event.lastError, "unknown_session");
    assert.equal(await findPaymentBySessionId(sessionId), null);
  }),

  test("first delivery for a paid session: payment order_created, checkout paid, one order", async () => {
    const now = new Date();
    const fixture = await insertCheckoutFixture({
      status: "open",
      expiresAt: new Date(now.getTime() + 20 * MINUTE_MS),
      amountCents: 10000,
      currency: "usd",
      createdAt: now,
    });

    const eventId = newTestEventId();
    const payload = buildCheckoutCompletedEvent({
      eventId,
      sessionId: fixture.sessionId,
      created: now,
      amountTotal: fixture.amountCents,
      currency: "usd",
      paymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
    });

    const response = await postStripeEvent(
      payload,
      signStripePayload(payload),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { received: true });

    const payment = await findPaymentBySessionId(fixture.sessionId);

    assert.ok(payment);
    assert.equal(payment.status, "order_created");
    assert.equal(payment.amountCents, fixture.amountCents);
    assert.equal(payment.currency, "USD");
    assert.equal(payment.paymentMethodType, "card");

    const checkout = await findCheckoutById(fixture.id);

    assert.ok(checkout);
    assert.equal(checkout.status, "paid");

    const orders = await findOrdersForCheckout(fixture.id);

    assert.equal(orders.length, 1);
    assert.match(orders[0].orderNumber, /^VISA-\d{4}-\d{6}$/);
    assert.equal(orders[0].amountCents, fixture.amountCents);

    const event = await findWebhookEvent(eventId);

    assert.ok(event);
    assert.equal(event.status, "processed");
    assert.equal(event.attemptCount, 1);
    assert.equal(event.lastError, null);
  }),

  test("duplicate delivery of the same event: 200 duplicate true, still one order and one payment", async () => {
    const now = new Date();
    const fixture = await insertCheckoutFixture({
      status: "open",
      expiresAt: new Date(now.getTime() + 20 * MINUTE_MS),
      amountCents: 12500,
      currency: "usd",
      createdAt: now,
    });

    const eventId = newTestEventId();
    const payload = buildCheckoutCompletedEvent({
      eventId,
      sessionId: fixture.sessionId,
      created: now,
      amountTotal: fixture.amountCents,
      currency: "usd",
      paymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
    });

    const first = await postStripeEvent(payload, signStripePayload(payload));

    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { received: true });

    const second = await postStripeEvent(payload, signStripePayload(payload));

    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { received: true, duplicate: true });

    const orders = await findOrdersForCheckout(fixture.id);
    const payment = await findPaymentBySessionId(fixture.sessionId);
    const event = await findWebhookEvent(eventId);

    assert.equal(orders.length, 1);
    assert.ok(payment);
    assert.equal(payment.status, "order_created");
    assert.ok(event);
    assert.equal(event.attemptCount, 1);
  }),

  test("late payment: review_required, checkout expired, no order, reason ['late_payment']", async () => {
    const now = new Date();
    const fixture = await insertCheckoutFixture({
      status: "open",
      expiresAt: new Date(now.getTime() - 60 * MINUTE_MS),
      amountCents: 10000,
      currency: "usd",
      createdAt: new Date(now.getTime() - 120 * MINUTE_MS),
    });

    const eventId = newTestEventId();
    const payload = buildCheckoutCompletedEvent({
      eventId,
      sessionId: fixture.sessionId,
      created: now,
      amountTotal: fixture.amountCents,
      currency: "usd",
      paymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
    });

    const response = await postStripeEvent(
      payload,
      signStripePayload(payload),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { received: true });

    const payment = await findPaymentBySessionId(fixture.sessionId);

    assert.ok(payment);
    assert.equal(payment.status, "review_required");

    const checkout = await findCheckoutById(fixture.id);

    assert.ok(checkout);
    assert.equal(checkout.status, "expired");
    assert.equal((await findOrdersForCheckout(fixture.id)).length, 0);

    const audits = await findAuditRowsForPayment(payment.id);

    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, "payment.review_required");
    assert.equal(audits[0].actorType, "system");
    assert.equal(audits[0].entityType, "payment");
    assert.equal(audits[0].entityId, payment.id);

    const metadata = audits[0].metadata as { reason?: string[] };

    assert.deepEqual(metadata.reason, ["late_payment"]);
  }),

  test("amount mismatch inside the window: review_required, checkout expired, reason ['amount_mismatch']", async () => {
    const now = new Date();
    const fixture = await insertCheckoutFixture({
      status: "open",
      expiresAt: new Date(now.getTime() + 20 * MINUTE_MS),
      amountCents: 10000,
      currency: "usd",
      createdAt: now,
    });

    const eventId = newTestEventId();
    const payload = buildCheckoutCompletedEvent({
      eventId,
      sessionId: fixture.sessionId,
      created: now,
      amountTotal: fixture.amountCents - 1,
      currency: "usd",
      paymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
    });

    const response = await postStripeEvent(
      payload,
      signStripePayload(payload),
    );

    assert.equal(response.status, 200);

    const payment = await findPaymentBySessionId(fixture.sessionId);

    assert.ok(payment);
    assert.equal(payment.status, "review_required");

    const checkout = await findCheckoutById(fixture.id);

    assert.ok(checkout);
    assert.equal(checkout.status, "expired");
    assert.equal((await findOrdersForCheckout(fixture.id)).length, 0);

    const audits = await findAuditRowsForPayment(payment.id);

    assert.equal(audits.length, 1);

    const metadata = audits[0].metadata as { reason?: string[] };

    assert.deepEqual(metadata.reason, ["amount_mismatch"]);
  }),
];
