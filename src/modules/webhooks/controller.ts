import type { Request, Response } from "express";
import { config } from "../../config.js";
import { HttpError } from "../../lib/errors.js";
import { verifyStripeEvent } from "../../lib/payments/stripe-webhook.js";
import { dummyPaymentBodySchema } from "./schema.js";
import { completePendingCheckout } from "./service.js";

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

  res.status(200).json(result);
}

export async function stripeWebhookController(
  req: Request,
  res: Response,
): Promise<void> {
  if (config.paymentProvider !== "stripe") {
    notFound();
  }

  const rawBody = req.body;

  if (!Buffer.isBuffer(rawBody)) {
    throw new HttpError(400, "Invalid webhook signature");
  }

  const signature = req.headers["stripe-signature"];

  if (typeof signature !== "string") {
    throw new HttpError(400, "Invalid webhook signature");
  }

  const event = verifyStripeEvent(rawBody, signature);

  if (
    event.type === "checkout.session.completed" &&
    event.data.object.payment_status === "paid"
  ) {
    await completePendingCheckout(event.data.object.id);
  }

  res.status(200).json({ received: true });
}
