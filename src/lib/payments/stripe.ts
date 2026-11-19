import Stripe from "stripe";
import { config } from "../../config.js";
import { HttpError } from "../errors.js";
import type {
  CheckoutInput,
  CheckoutSession,
  ExistingCheckout,
  PaymentProvider,
} from "./types.js";

let stripeClient: Stripe | undefined;

function getStripeClient(): Stripe {
  if (!config.stripeSecretKey) {
    throw new HttpError(500, "Something went wrong", "internal_error");
  }

  stripeClient ??= new Stripe(config.stripeSecretKey);

  return stripeClient;
}

/**
 * Fixed log line plus the pending checkout reference only. The Stripe error
 * object is never logged, because it can echo request details.
 */
function stripeFailure(reference?: string): HttpError {
  if (reference) {
    console.error(`Stripe request failed for pending checkout ${reference}`);
  } else {
    console.error("Stripe request failed");
  }

  return new HttpError(500, "Something went wrong", "internal_error");
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe" as const;

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    let session: Stripe.Checkout.Session;
    // Stripe's minimum is 30 minutes from now; 31 minutes leaves a small
    // margin so the returned expires_at is never rejected as too soon.
    const requestedExpiresAt = Math.floor(Date.now() / 1000) + 31 * 60;

    try {
      session = await getStripeClient().checkout.sessions.create(
        {
          mode: "payment",
          // allowed_payment_method_types filters Stripe's dynamically computed methods.
          // Card-only keeps every payment inside payments_payment_method_type_check.
          allowed_payment_method_types: ["card"],
          expires_at: requestedExpiresAt,
          client_reference_id: input.reference,
          metadata: {
            reference: input.reference,
          },
          success_url: `${input.successUrl}?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: input.cancelUrl,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: input.currency.toLowerCase(),
                unit_amount: input.amountCents,
                product_data: {
                  name: `Visa application ${input.reference}`,
                },
              },
            },
          ],
        },
        input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : undefined,
      );
    } catch {
      throw stripeFailure(input.reference);
    }

    if (!session.url) {
      throw stripeFailure(input.reference);
    }

    return {
      url: session.url,
      sessionId: session.id,
      // Stripe's value, never requestedExpiresAt.
      expiresAt: session.expires_at,
    };
  }

  async getCheckout(sessionId: string): Promise<ExistingCheckout | null> {
    let session: Stripe.Checkout.Session;

    try {
      session = await getStripeClient().checkout.sessions.retrieve(sessionId);
    } catch {
      throw stripeFailure();
    }

    if (session.status === "open") {
      return { status: "open", url: session.url, expiresAt: session.expires_at };
    }

    if (session.status === "complete") {
      return {
        status: "complete",
        url: session.url,
        expiresAt: session.expires_at,
      };
    }

    if (session.status === "expired") {
      return { status: "expired", url: null, expiresAt: session.expires_at };
    }

    // Any other status (including null) is not a session we can reason about,
    // so fail instead of creating a replacement.
    throw stripeFailure();
  }

  async isPaid(sessionId: string): Promise<boolean> {
    try {
      const session = await getStripeClient().checkout.sessions.retrieve(
        sessionId,
      );

      return session.payment_status === "paid";
    } catch {
      throw stripeFailure();
    }
  }
}
