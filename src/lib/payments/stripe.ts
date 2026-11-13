import Stripe from "stripe";
import { config } from "../../config.js";
import { HttpError } from "../errors.js";
import type {
  CheckoutInput,
  CheckoutSession,
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

    try {
      session = await getStripeClient().checkout.sessions.create({
        mode: "payment",
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
      });
    } catch {
      throw stripeFailure(input.reference);
    }

    if (!session.url) {
      throw stripeFailure(input.reference);
    }

    return { url: session.url, sessionId: session.id };
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
