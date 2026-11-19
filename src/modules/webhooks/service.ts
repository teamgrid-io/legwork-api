import { randomInt } from "node:crypto";
import { and, eq, gte, inArray, lt, lte, notExists, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import {
  applicants,
  auditLogs,
  orderEvents,
  orderItems,
  orders,
  payments,
  pendingCheckouts,
  stripeWebhookEvents,
} from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";
import { decidePaymentOutcome, MAX_STRIPE_EVENT_ATTEMPTS } from "./policy.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CheckoutRow = typeof pendingCheckouts.$inferSelect;

export interface StripePaymentInput {
  amountCents: number | null;
  currency: string | null;
  paymentIntentId: string | null;
  paymentMethodType: string;
  paidAt: Date;
}

export interface CompleteCheckoutResult {
  status: "order_created" | "review_required" | "unknown_session";
  orderNumber: string | null;
  created: boolean;
}

function generateOrderNumber(): string {
  const year = new Date().getUTCFullYear();
  const suffix = randomInt(0, 1_000_000).toString().padStart(6, "0");

  return `VISA-${year}-${suffix}`;
}

/**
 * Replay router. Reloads the payment row and returns its decided outcome.
 * Returns null only when the row is still `succeeded` (caller re-decides).
 * There is no 409 here: a decided payment is a valid, idempotent replay.
 */
async function routeDecidedPayment(
  tx: Tx,
  paymentId: string,
  pendingCheckoutId: string,
): Promise<CompleteCheckoutResult | null> {
  const [row] = await tx
    .select({ status: payments.status })
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);

  if (!row) {
    throw new Error("Payment row disappeared");
  }

  if (row.status === "review_required") {
    return { status: "review_required", orderNumber: null, created: false };
  }

  if (row.status === "order_created") {
    const [order] = await tx
      .select({ orderNumber: orders.orderNumber })
      .from(orders)
      .where(eq(orders.pendingCheckoutId, pendingCheckoutId))
      .limit(1);

    if (!order) {
      throw new Error("order_created payment has no order");
    }

    return {
      status: "order_created",
      orderNumber: order.orderNumber,
      created: false,
    };
  }

  return null;
}

/**
 * One order-creation helper for T1 (actor "stripe") and, later, T3 ("staff").
 * `orders.pending_checkout_id` is UNIQUE, so the database guarantees one order
 * per checkout even if this is entered twice.
 */
async function createOrderFromCheckout(
  tx: Tx,
  checkout: CheckoutRow,
  actorType: "stripe" | "staff",
): Promise<{ orderNumber: string; created: boolean }> {
  const [existing] = await tx
    .select({ orderNumber: orders.orderNumber })
    .from(orders)
    .where(eq(orders.pendingCheckoutId, checkout.id))
    .limit(1);

  if (existing) {
    return { orderNumber: existing.orderNumber, created: false };
  }

  const travellers = checkout.travellers;

  if (!Array.isArray(travellers)) {
    throw new Error("pending_checkouts.travellers must be an array");
  }

  if (travellers.length !== checkout.travellerCount) {
    throw new Error(
      "pending_checkouts.travellers count does not match traveller_count",
    );
  }

  const applicantDetails = travellers.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("Invalid traveller entry");
    }

    const {
      first_name: firstName,
      surname,
      gender,
      maritalStatus,
    } = entry as Record<string, unknown>;

    if (typeof firstName !== "string" || typeof surname !== "string") {
      throw new Error("Invalid traveller name");
    }

    if (typeof gender !== "string" || typeof maritalStatus !== "string") {
      throw new Error("Invalid traveller details");
    }

    return { firstName, surname, gender, maritalStatus };
  });

  const paidAt = new Date();
  let order: { id: string; orderNumber: string } | undefined;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const orderNumber = generateOrderNumber();

    const [inserted] = await tx
      .insert(orders)
      .values({
        orderNumber,
        pendingCheckoutId: checkout.id,
        visaProductId: checkout.visaProductId,
        passportCountryId: checkout.passportCountryId,
        originCountryId: checkout.originCountryId,
        travelDate: checkout.travelDate,
        travellerCount: checkout.travellerCount,
        contactEmail: checkout.contactEmail,
        contactPhone: checkout.contactPhone,
        formVersion: checkout.formVersion,
        amountCents: checkout.amountCents,
        currency: checkout.currency,
        status: "paid",
        paidAt,
      })
      // Catches UNIQUE(order_number) and UNIQUE(pending_checkout_id).
      .onConflictDoNothing()
      .returning({ id: orders.id, orderNumber: orders.orderNumber });

    if (inserted) {
      order = inserted;
      break;
    }

    const [raced] = await tx
      .select({ id: orders.id, orderNumber: orders.orderNumber })
      .from(orders)
      .where(eq(orders.pendingCheckoutId, checkout.id))
      .limit(1);

    if (raced) {
      return { orderNumber: raced.orderNumber, created: false };
    }
  }

  if (!order) {
    throw new Error("Could not generate a unique order number");
  }

  const createdOrder = order;

  await tx.insert(orderItems).values([
    {
      orderId: createdOrder.id,
      itemType: "government_fee",
      description: "Government fee",
      quantity: checkout.travellerCount,
      unitAmountCents: checkout.governmentFeeCents,
      totalAmountCents: checkout.governmentFeeCents * checkout.travellerCount,
      currency: checkout.currency,
    },
    {
      orderId: createdOrder.id,
      itemType: "service_fee",
      description: "Service fee",
      quantity: checkout.travellerCount,
      unitAmountCents: checkout.legworkFeeCents,
      totalAmountCents: checkout.legworkFeeCents * checkout.travellerCount,
      currency: checkout.currency,
    },
  ]);

  await tx.insert(applicants).values(
    applicantDetails.map((applicant, index) => ({
      orderId: createdOrder.id,
      sortOrder: index + 1,
      firstName: applicant.firstName,
      surname: applicant.surname,
      answers: {
        gender: applicant.gender,
        marital_status: applicant.maritalStatus,
      },
      status: "incomplete",
    })),
  );

  await tx.insert(orderEvents).values({
    orderId: createdOrder.id,
    fromStatus: null,
    toStatus: "paid",
    actorType,
    note: "Payment confirmed",
  });

  return { orderNumber: createdOrder.orderNumber, created: true };
}

export async function completePendingCheckout(
  sessionId: string,
  payment?: StripePaymentInput,
): Promise<CompleteCheckoutResult> {
  return db.transaction(async (tx) => {
    // Lock order: first statement in the transaction locks the checkout row,
    // before the T0 payments insert. FOR UPDATE on a missing row locks nothing;
    // the event claim keeps concurrent deliveries apart.
    const [checkout] = await tx
      .select()
      .from(pendingCheckouts)
      .where(eq(pendingCheckouts.stripeSessionId, sessionId))
      .limit(1)
      .for("update");

    // Unknown session: no write. The controller answers 200, marks the event
    // processed with last_error='unknown_session', and logs event id and type.
    if (!checkout) {
      return { status: "unknown_session", orderNumber: null, created: false };
    }

    // Decision time is payment time. Lateness and the expired side effect are
    // judged against when the payment happened, not when this delivery is
    // processed. Processing time is used only for updated_at.
    const processingNow = new Date();
    const decisionTime = payment?.paidAt ?? processingNow;

    // Expired side effect: runs before T0 on purpose. Its NOT EXISTS guard
    // means "this checkout has no recorded money", so it must not see the row
    // this delivery is about to insert. A checkout with a payments row is
    // never overwritten here.
    await tx
      .update(pendingCheckouts)
      .set({ status: "expired" })
      .where(
        and(
          eq(pendingCheckouts.id, checkout.id),
          eq(pendingCheckouts.status, "open"),
          lte(pendingCheckouts.expiresAt, decisionTime),
          notExists(
            tx
              .select({ id: payments.id })
              .from(payments)
              .where(eq(payments.pendingCheckoutId, checkout.id)),
          ),
        ),
      );

    // T0, record first: the money is written before any deadline or amount
    // decision. ON CONFLICT (stripe_session_id) DO NOTHING, then reselect.
    const [inserted] = await tx
      .insert(payments)
      .values({
        pendingCheckoutId: checkout.id,
        stripeSessionId: sessionId,
        paymentIntentId: payment?.paymentIntentId ?? null,
        // Defence in depth: a paid Checkout Session always carries both. The
        // decision below compares the raw event values, not these fallbacks.
        amountCents: payment?.amountCents ?? checkout.amountCents,
        currency: (payment?.currency ?? checkout.currency).toUpperCase(),
        paymentMethodType: payment?.paymentMethodType ?? "card",
        status: "succeeded",
        paidAt: payment?.paidAt ?? processingNow,
      })
      .onConflictDoNothing({ target: payments.stripeSessionId })
      .returning({ id: payments.id, status: payments.status });

    const [paymentRow] = inserted
      ? [inserted]
      : await tx
          .select({ id: payments.id, status: payments.status })
          .from(payments)
          .where(eq(payments.stripeSessionId, sessionId))
          .limit(1);

    if (!paymentRow) {
      throw new Error("Payment row missing after insert");
    }

    // Replay: a previously decided payment returns its outcome. order_created
    // returns the existing order; review_required returns without a second
    // order, a second audit row, or a status regression.
    if (paymentRow.status !== "succeeded") {
      const routed = await routeDecidedPayment(
        tx,
        paymentRow.id,
        checkout.id,
      );

      if (!routed) {
        throw new Error("Decided payment could not be routed");
      }

      return routed;
    }

    // Decide: amount or currency mismatch, or payment time >= expires_at + grace.
    // Codes come back in fixed order: late_payment, amount_mismatch,
    // currency_mismatch. Null amount/currency fail closed as a mismatch.
    const reasons = decidePaymentOutcome({
      now: decisionTime,
      expiresAt: checkout.expiresAt,
      graceSeconds: config.paymentReviewGraceSeconds,
      paymentAmountCents: payment ? payment.amountCents : checkout.amountCents,
      paymentCurrency: payment ? payment.currency : checkout.currency,
      checkoutAmountCents: checkout.amountCents,
      checkoutCurrency: checkout.currency,
    });

    // Late or mismatched: review_required, and the checkout is expired below.
    // Audit row with actor_type 'system'.
    if (reasons.length > 0) {
      const [marked] = await tx
        .update(payments)
        .set({ status: "review_required", updatedAt: processingNow })
        .where(
          and(
            eq(payments.id, paymentRow.id),
            eq(payments.status, "succeeded"),
          ),
        )
        .returning({ id: payments.id });

      // Lost guarded update: reload and route through the same decision.
      if (!marked) {
        const routed = await routeDecidedPayment(
          tx,
          paymentRow.id,
          checkout.id,
        );

        if (!routed) {
          throw new Error("Payment stayed succeeded after a lost review update");
        }

        return routed;
      }

      // A payment routed to review also expires the checkout; a paid checkout is
      // never changed.
      await tx
        .update(pendingCheckouts)
        .set({ status: "expired" })
        .where(
          and(
            eq(pendingCheckouts.id, checkout.id),
            eq(pendingCheckouts.status, "open"),
          ),
        );

      await tx.insert(auditLogs).values({
        actorType: "system",
        action: "payment.review_required",
        entityType: "payment",
        entityId: paymentRow.id,
        metadata: {
          previous_status: "succeeded",
          new_status: "review_required",
          reason: reasons,
        },
      });

      return { status: "review_required", orderNumber: null, created: false };
    }

    // T1: guarded transition succeeded -> order_created.
    const [won] = await tx
      .update(payments)
      .set({ status: "order_created", updatedAt: processingNow })
      .where(
        and(
          eq(payments.id, paymentRow.id),
          eq(payments.status, "succeeded"),
        ),
      )
      .returning({ id: payments.id });

    // Lost guarded update (old race path): reload and route. No 409, no 500.
    // Nothing moves a payment back to 'succeeded', so this always routes.
    if (!won) {
      const routed = await routeDecidedPayment(tx, paymentRow.id, checkout.id);

      if (!routed) {
        throw new Error("Payment stayed succeeded after a lost order update");
      }

      return routed;
    }

    // Checkout becomes paid from open or expired, in this same transaction.
    await tx
      .update(pendingCheckouts)
      .set({ status: "paid" })
      .where(
        and(
          eq(pendingCheckouts.id, checkout.id),
          inArray(pendingCheckouts.status, ["open", "expired"]),
        ),
      );

    const order = await createOrderFromCheckout(tx, checkout, "stripe");

    return {
      status: "order_created",
      orderNumber: order.orderNumber,
      created: order.created,
    };
  });
}

export type StripeEventClaim =
  | "claimed"
  | "processed"
  | "processing"
  | "exhausted";

/**
 * Claim the event id before any business work.
 * - not seen   -> INSERT succeeds -> "claimed" (attempt_count 1, the first claim)
 * - processed  -> "processed"     -> 200 duplicate
 * - processing -> "processing"    -> 503, Stripe retries
 * - failed with attempt_count < 5  -> reclaim, attempt_count + 1
 * - failed with attempt_count >= 5 -> "exhausted", last_error
 *   'max_attempts_exceeded', no further claim
 * - vanished between insert and select -> "processing"
 */
export async function claimStripeEvent(
  eventId: string,
  eventType: string,
): Promise<StripeEventClaim> {
  const [inserted] = await db
    .insert(stripeWebhookEvents)
    .values({ eventId, eventType, status: "processing", attemptCount: 1 })
    .onConflictDoNothing({ target: stripeWebhookEvents.eventId })
    .returning({ eventId: stripeWebhookEvents.eventId });

  if (inserted) {
    return "claimed";
  }

  const [existing] = await db
    .select({
      status: stripeWebhookEvents.status,
      attemptCount: stripeWebhookEvents.attemptCount,
    })
    .from(stripeWebhookEvents)
    .where(eq(stripeWebhookEvents.eventId, eventId))
    .limit(1);

  if (!existing) {
    return "processing";
  }

  if (existing.status === "processed") {
    return "processed";
  }

  if (existing.status === "processing") {
    return "processing";
  }

  // Reclaim a failed event, but only while it still has a claim left. The single
  // increment lives here: attempt_count + 1 on a successful reclaim, nowhere
  // else. received_at resets so the sweeper's 10-minute clock restarts.
  const [reclaimed] = await db
    .update(stripeWebhookEvents)
    .set({
      status: "processing",
      receivedAt: new Date(),
      attemptCount: sql`${stripeWebhookEvents.attemptCount} + 1`,
    })
    .where(
      and(
        eq(stripeWebhookEvents.eventId, eventId),
        eq(stripeWebhookEvents.status, "failed"),
        lt(stripeWebhookEvents.attemptCount, MAX_STRIPE_EVENT_ATTEMPTS),
      ),
    )
    .returning({ eventId: stripeWebhookEvents.eventId });

  if (reclaimed) {
    return "claimed";
  }

  // No row: either the state changed under us, or the cap is reached. Re-read
  // to tell the two apart. The guarded update below only writes a bounded code;
  // it never touches attempt_count.
  const [afterReclaim] = await db
    .select({
      status: stripeWebhookEvents.status,
      attemptCount: stripeWebhookEvents.attemptCount,
    })
    .from(stripeWebhookEvents)
    .where(eq(stripeWebhookEvents.eventId, eventId))
    .limit(1);

  if (
    afterReclaim?.status === "failed" &&
    afterReclaim.attemptCount >= MAX_STRIPE_EVENT_ATTEMPTS
  ) {
    await db
      .update(stripeWebhookEvents)
      .set({ lastError: "max_attempts_exceeded" })
      .where(
        and(
          eq(stripeWebhookEvents.eventId, eventId),
          eq(stripeWebhookEvents.status, "failed"),
          gte(stripeWebhookEvents.attemptCount, MAX_STRIPE_EVENT_ATTEMPTS),
        ),
      );

    return "exhausted";
  }

  return "processing";
}

/** Runs only after the business transaction has committed. */
export async function markStripeEventProcessed(
  eventId: string,
  lastError: string | null = null,
): Promise<void> {
  await db
    .update(stripeWebhookEvents)
    .set({ status: "processed", processedAt: new Date(), lastError })
    .where(eq(stripeWebhookEvents.eventId, eventId));
}

/**
 * Bounded code only: 'http_<status>' or 'internal_error'. No attempt_count
 * increment here; the single increment happens on claim.
 */
export async function markStripeEventFailed(
  eventId: string,
  error: unknown,
): Promise<void> {
  const code =
    error instanceof HttpError ? `http_${error.statusCode}` : "internal_error";

  try {
    await db
      .update(stripeWebhookEvents)
      .set({ status: "failed", lastError: code })
      .where(
        and(
          eq(stripeWebhookEvents.eventId, eventId),
          eq(stripeWebhookEvents.status, "processing"),
        ),
      );
  } catch {
    // The row stays 'processing'; the sweeper reclaims it. Fixed line, id only.
    console.error(`Could not record failure for Stripe webhook event ${eventId}`);
  }
}
