import assert from "node:assert/strict";
import { test } from "node:test";
import { sweepStaleStripeEvents } from "../../src/jobs/sweep-stripe-webhook-events.js";
import {
  findWebhookEvent,
  insertWebhookEventFixture,
  newTestEventId,
} from "../helpers/db.js";

const MINUTE_MS = 60 * 1000;

export const suiteTests: Array<Promise<void>> = [
  test("processing row received 11 minutes ago becomes failed with stale_processing, attempt_count unchanged", async () => {
    const eventId = newTestEventId();

    await insertWebhookEventFixture(eventId, {
      status: "processing",
      attemptCount: 2,
      receivedAt: new Date(Date.now() - 11 * MINUTE_MS),
    });

    const changed = await sweepStaleStripeEvents(new Date());

    assert.ok(changed >= 1);

    const event = await findWebhookEvent(eventId);

    assert.ok(event);
    assert.equal(event.status, "failed");
    assert.equal(event.lastError, "stale_processing");
    assert.equal(event.attemptCount, 2);
    assert.equal(event.processedAt, null);
  }),

  test("processing row at attempt_count 5 received 11 minutes ago becomes failed with max_attempts_exceeded", async () => {
    const eventId = newTestEventId();

    await insertWebhookEventFixture(eventId, {
      status: "processing",
      attemptCount: 5,
      receivedAt: new Date(Date.now() - 11 * MINUTE_MS),
    });

    await sweepStaleStripeEvents(new Date());

    const event = await findWebhookEvent(eventId);

    assert.ok(event);
    assert.equal(event.status, "failed");
    assert.equal(event.lastError, "max_attempts_exceeded");
    assert.equal(event.attemptCount, 5);
  }),

  test("processing row received 1 minute ago is untouched", async () => {
    const eventId = newTestEventId();

    await insertWebhookEventFixture(eventId, {
      status: "processing",
      attemptCount: 1,
      receivedAt: new Date(Date.now() - MINUTE_MS),
    });

    await sweepStaleStripeEvents(new Date());

    const event = await findWebhookEvent(eventId);

    assert.ok(event);
    assert.equal(event.status, "processing");
    assert.equal(event.lastError, null);
    assert.equal(event.attemptCount, 1);
  }),

  test("processed row is never touched, even when old", async () => {
    const eventId = newTestEventId();

    await insertWebhookEventFixture(eventId, {
      status: "processed",
      attemptCount: 1,
      receivedAt: new Date(Date.now() - 11 * MINUTE_MS),
    });

    await sweepStaleStripeEvents(new Date());

    const event = await findWebhookEvent(eventId);

    assert.ok(event);
    assert.equal(event.status, "processed");
    assert.equal(event.lastError, null);
    assert.equal(event.attemptCount, 1);
  }),
];
