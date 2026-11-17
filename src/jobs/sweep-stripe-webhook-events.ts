import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { stripeWebhookEvents } from "../db/schema.js";
import { MAX_STRIPE_EVENT_ATTEMPTS } from "../modules/webhooks/policy.js";

// A Stripe event stuck in "processing" is one whose delivery claimed the row and
// then crashed before it could be marked processed or failed. The claim path
// answers 503 for a row in that state, so Stripe retries; the sweep makes the
// row reclaimable again by moving it to "failed".
//
// This module is deliberately DB-only: it must not import the Redis helpers,
// which open a connection at module load and would break the unit tests.
const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Mark processing events older than the stale threshold as failed, so the next
 * delivery reclaims them. Returns how many rows changed.
 *
 * The failure reason is decided in the same statement: an event that has used
 * all its claims is recorded as 'max_attempts_exceeded' and will never be
 * reclaimed, so it needs a human. attempt_count is not touched: the single
 * increment happens on claim in claimStripeEvent, never in a sweep.
 */
export async function sweepStaleStripeEvents(
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);

  const rows = await db
    .update(stripeWebhookEvents)
    .set({
      status: "failed",
      lastError: sql`case when ${stripeWebhookEvents.attemptCount} >= ${MAX_STRIPE_EVENT_ATTEMPTS} then 'max_attempts_exceeded' else 'stale_processing' end`,
    })
    .where(
      and(
        eq(stripeWebhookEvents.status, "processing"),
        lt(stripeWebhookEvents.receivedAt, cutoff),
      ),
    )
    .returning({
      eventId: stripeWebhookEvents.eventId,
      attemptCount: stripeWebhookEvents.attemptCount,
    });

  for (const row of rows) {
    if (row.attemptCount >= MAX_STRIPE_EVENT_ATTEMPTS) {
      console.error(
        `Stripe webhook sweep: event ${row.eventId} needs manual investigation (max_attempts_exceeded)`,
      );
    }
  }

  console.log(
    `Stripe webhook sweep: ${rows.length} stale event(s) marked failed`,
  );

  return rows.length;
}
