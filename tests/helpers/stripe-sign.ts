import { createHmac } from "node:crypto";

// The server derives its webhook secret from STRIPE_WEBHOOK_SECRET, which
// tests/run.ts sets to this placeholder before any src/ module is imported.
export const WEBHOOK_SECRET = "whsec_test_placeholder";

/**
 * Stripe-Signature header value: `t=<unix seconds>,v1=<hex hmac>`.
 * The HMAC is SHA-256 over `${timestamp}.${payload}` keyed with the webhook
 * secret. Pure computation, no network.
 */
export function signStripePayload(
  payload: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const v1 = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestampSeconds}.${payload}`)
    .digest("hex");

  return `t=${timestampSeconds},v1=${v1}`;
}

export interface CheckoutCompletedInput {
  eventId: string;
  sessionId: string;
  created: Date;
  amountTotal: number | null;
  currency?: string;
  paymentStatus?: "paid" | "unpaid";
  paymentMethodTypes?: string[];
  paymentIntentId?: string | null;
}

/**
 * A minimal but structurally valid `checkout.session.completed` event. Only the
 * fields the controller reads are meaningful; `created` is set explicitly so
 * lateness is deterministic.
 */
export function buildCheckoutCompletedEvent(
  input: CheckoutCompletedInput,
): string {
  const createdSeconds = Math.floor(input.created.getTime() / 1000);

  return JSON.stringify({
    id: input.eventId,
    object: "event",
    api_version: "2026-10-28.endive",
    created: createdSeconds,
    data: {
      object: {
        id: input.sessionId,
        object: "checkout.session",
        mode: "payment",
        livemode: false,
        payment_status: input.paymentStatus ?? "paid",
        amount_total: input.amountTotal,
        currency: input.currency ?? "usd",
        payment_method_types: input.paymentMethodTypes ?? ["card"],
        payment_intent: input.paymentIntentId ?? null,
        metadata: {},
        client_reference_id: null,
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: "checkout.session.completed",
  });
}
