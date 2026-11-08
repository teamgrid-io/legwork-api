import Stripe from "stripe";
import { config } from "../../config.js";
import { HttpError } from "../errors.js";

let stripeClient: Stripe | undefined;

function getStripeClient(): Stripe {
  if (!config.stripeSecretKey) {
    throw new HttpError(400, "Invalid webhook signature");
  }

  stripeClient ??= new Stripe(config.stripeSecretKey);

  return stripeClient;
}

export function verifyStripeEvent(
  rawBody: Buffer,
  signature: string,
): Stripe.Event {
  if (!config.stripeWebhookSecret) {
    throw new HttpError(400, "Invalid webhook signature");
  }

  try {
    return getStripeClient().webhooks.constructEvent(
      rawBody,
      signature,
      config.stripeWebhookSecret,
    );
  } catch {
    throw new HttpError(400, "Invalid webhook signature");
  }
}
