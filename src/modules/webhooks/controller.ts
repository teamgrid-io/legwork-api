import type { Request, Response } from "express";
import { config } from "../../config.js";
import { HttpError } from "../../lib/errors.js";
import { verifyStripeEvent } from "../../lib/payments/stripe-webhook.js";
import { dummyPaymentBodySchema } from "./schema.js";
import {
  claimStripeEvent,
  completePendingCheckout,
  markStripeEventFailed,
  markStripeEventProcessed,
} from "./service.js";

function notFound(): never {
  throw new HttpError(404, "Not found", "not_found");
}

export async function dummyPaymentController(
  req: Request,
  res: Response,
): Promise<void> {
  if (config.paymentProvider !== "dummy" || config.isProduction) {
    notFound();
  }

  const { sessionId } = dummyPaymentBodySchema.parse(req.body);
  const result = await completePendingCheckout(sessionId);

  // Dev-only endpoint keeps its existing 404 contract.
  if (result.status === "unknown_session") {
    throw new HttpError(404, "Unknown payment session");
  }

  res.status(200).json(result);
}

export async function stripeWebhookController(
  req: Request,
  res: Response,
): Promise<void> {
  if (config.paymentProvider !== "stripe") {
    notFound();
  }

  // 1. Signature from the raw Buffer. express.raw in routes.ts.
  const rawBody = req.body;

  if (!Buffer.isBuffer(rawBody)) {
    throw new HttpError(400, "Invalid webhook signature");
  }

  const signature = req.headers["stripe-signature"];

  if (typeof signature !== "string") {
    throw new HttpError(400, "Invalid webhook signature");
  }

  const event = verifyStripeEvent(rawBody, signature);

  // 2. Claim:
  // INSERT (event_id, event_type, status 'processing', attempt_count 1)
  //   ON CONFLICT (event_id) DO NOTHING RETURNING event_id;
  // no row -> classify the existing row (processed / processing / failed / exhausted).
  const claim = await claimStripeEvent(event.id, event.type);

  if (claim === "processed") {
    res.status(200).json({ received: true, duplicate: true });
    return;
  }

  if (claim === "processing") {
    // First delivery may still be in flight, or it crashed and the sweeper has
    // not reclaimed it yet. Stripe retries on 503.
    throw new HttpError(503, "Webhook is being processed, try again");
  }

  if (claim === "exhausted") {
    // The event id has used all MAX_STRIPE_EVENT_ATTEMPTS claims. Answer 200 so
    // Stripe stops retrying, and leave the row for a human. Fixed fields only:
    // event id and type, no payload, session id, amount, or error message.
    console.error(
      `Stripe webhook event ${event.id} (${event.type}) failed: max_attempts_exceeded; manual investigation required`,
    );

    res.status(200).json({ received: true, failed: "max_attempts_exceeded" });
    return;
  }

  // Marks the event processed AFTER the business transaction commits.
  // A failed update must not be answered 200 with the row still 'processing':
  // answer 503 so Stripe retries, and the sweeper frees the row meanwhile.
  const acknowledge = async (lastError: string | null = null): Promise<void> => {
    try {
      await markStripeEventProcessed(event.id, lastError);
    } catch {
      throw new HttpError(503, "Webhook is being processed, try again");
    }
  };

  // 3. Non-paid or non-checkout event: nothing to record, acknowledge 200.
  if (
    event.type !== "checkout.session.completed" ||
    event.data.object.payment_status !== "paid"
  ) {
    await acknowledge();
    res.status(200).json({ received: true });
    return;
  }

  // 4. Paid checkout.session.completed.
  let unknownSession = false;

  try {
    const session = event.data.object;

    // Card only: payments_payment_method_type_check requires 'card'. A missing
    // or different method is a bounded error, never defaulted to 'card'.
    const methodType = session.payment_method_types?.[0];

    if (methodType !== "card") {
      throw new Error("Unsupported Checkout Session payment method type");
    }

    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : (session.payment_intent?.id ?? null);

    // Lateness is judged at payment time, not at processing time: event.created
    // is when Stripe saw the payment. The same value is the decision time inside
    // completePendingCheckout, so a delayed delivery cannot make a punctual
    // payment look late.
    const paidAt = new Date(event.created * 1000);

    const result = await completePendingCheckout(session.id, {
      amountCents: session.amount_total,
      currency: session.currency,
      paymentIntentId,
      paymentMethodType: methodType,
      paidAt,
    });

    if (result.status === "unknown_session") {
      unknownSession = true;
      // Error level, fixed fields only: event id and type. No session id, URL,
      // amount, email, payload, or signature.
      console.error(
        `Stripe webhook event ${event.id} (${event.type}) references an unknown checkout session`,
      );
    }
  } catch (error) {
    // Bounded code, no attempt_count increment (that happens on claim), then
    // rethrow so Stripe sees a non-2xx and retries.
    await markStripeEventFailed(event.id, error);
    throw error;
  }

  // Business transaction has committed. unknown_session still answers 200 but
  // records last_error='unknown_session' so the row explains itself.
  await acknowledge(unknownSession ? "unknown_session" : null);

  res.status(200).json({ received: true });
}
