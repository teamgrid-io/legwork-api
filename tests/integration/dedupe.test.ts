import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { postStripeEvent } from "../helpers/server.js";
import {
  buildCheckoutCompletedEvent,
  signStripePayload,
} from "../helpers/stripe-sign.js";
import {
  findOrdersForCheckout,
  findPaymentBySessionId,
  findWebhookEvent,
  insertCheckoutFixture,
  insertWebhookEventFixture,
  newTestEventId,
} from "../helpers/db.js";

const MINUTE_MS = 60 * 1000;

async function openFixture(amountCents: number) {
  const now = new Date();

  return insertCheckoutFixture({
    status: "open",
    expiresAt: new Date(now.getTime() + 20 * MINUTE_MS),
    amountCents,
    currency: "usd",
    createdAt: now,
  });
}

export const suiteTests: Array<Promise<void>> = [
  test("existing processing row: 503, no business write, attempt_count unchanged", async () => {
    const eventId = newTestEventId();
    const fixture = await openFixture(10000);

    await insertWebhookEventFixture(eventId, {
      status: "processing",
      attemptCount: 1,
      receivedAt: new Date(),
    });

    const payload = buildCheckoutCompletedEvent({
      eventId,
      sessionId: fixture.sessionId,
      created: new Date(),
      amountTotal: fixture.amountCents,
      paymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
    });

    const response = await postStripeEvent(
      payload,
      signStripePayload(payload),
    );

    assert.equal(response.status, 503);

    const event = await findWebhookEvent(eventId);

    assert.ok(event);
    assert.equal(event.status, "processing");
    assert.equal(event.attemptCount, 1);
    assert.equal(await findPaymentBySessionId(fixture.sessionId), null);
    assert.equal((await findOrdersForCheckout(fixture.id)).length, 0);
  }),

  test("existing failed row with attempt_count 2 is reclaimed: 200, attempt_count 3", async () => {
    const eventId = newTestEventId();
    const fixture = await openFixture(10000);

    await insertWebhookEventFixture(eventId, {
      status: "failed",
      attemptCount: 2,
      receivedAt: new Date(Date.now() - MINUTE_MS),
      lastError: "internal_error",
    });

    const payload = buildCheckoutCompletedEvent({
      eventId,
      sessionId: fixture.sessionId,
      created: new Date(),
      amountTotal: fixture.amountCents,
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
    assert.equal(event.attemptCount, 3);
    assert.equal(event.lastError, null);

    const payment = await findPaymentBySessionId(fixture.sessionId);

    assert.ok(payment);
    assert.equal(payment.status, "order_created");
    assert.equal((await findOrdersForCheckout(fixture.id)).length, 1);
  }),

  test("existing failed row with attempt_count 5: 200 failed max_attempts_exceeded, attempt_count stays 5, no business write", async () => {
    const eventId = newTestEventId();
    const fixture = await openFixture(10000);

    await insertWebhookEventFixture(eventId, {
      status: "failed",
      attemptCount: 5,
      receivedAt: new Date(Date.now() - MINUTE_MS),
      lastError: "internal_error",
    });

    const payload = buildCheckoutCompletedEvent({
      eventId,
      sessionId: fixture.sessionId,
      created: new Date(),
      amountTotal: fixture.amountCents,
      paymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
    });

    const response = await postStripeEvent(
      payload,
      signStripePayload(payload),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      received: true,
      failed: "max_attempts_exceeded",
    });

    const event = await findWebhookEvent(eventId);

    assert.ok(event);
    assert.equal(event.status, "failed");
    assert.equal(event.attemptCount, 5);
    assert.equal(event.lastError, "max_attempts_exceeded");

    assert.equal(await findPaymentBySessionId(fixture.sessionId), null);
    assert.equal((await findOrdersForCheckout(fixture.id)).length, 0);
  }),

  test("existing processed row: 200 duplicate true, attempt_count unchanged", async () => {
    const eventId = newTestEventId();
    const fixture = await openFixture(10000);

    await insertWebhookEventFixture(eventId, {
      status: "processed",
      attemptCount: 4,
      receivedAt: new Date(Date.now() - MINUTE_MS),
    });

    const payload = buildCheckoutCompletedEvent({
      eventId,
      sessionId: fixture.sessionId,
      created: new Date(),
      amountTotal: fixture.amountCents,
      paymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
    });

    const response = await postStripeEvent(
      payload,
      signStripePayload(payload),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { received: true, duplicate: true });

    const event = await findWebhookEvent(eventId);

    assert.ok(event);
    assert.equal(event.status, "processed");
    assert.equal(event.attemptCount, 4);

    assert.equal(await findPaymentBySessionId(fixture.sessionId), null);
    assert.equal((await findOrdersForCheckout(fixture.id)).length, 0);
  }),
];
