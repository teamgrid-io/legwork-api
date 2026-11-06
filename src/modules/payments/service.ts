import { and, eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { requests } from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";
import { paymentProvider } from "../../lib/payments/index.js";

export async function createCheckoutForRequest(
  requestId: string,
): Promise<{ url: string }> {
  const [request] = await db
    .select({
      id: requests.id,
      reference: requests.reference,
      amountCents: requests.amountCents,
      currency: requests.currency,
      paymentStatus: requests.paymentStatus,
    })
    .from(requests)
    .where(eq(requests.id, requestId))
    .limit(1);

  if (!request) {
    throw new HttpError(404, "Request not found");
  }

  if (request.paymentStatus === "paid") {
    throw new HttpError(409, "Request is already paid");
  }

  const session = await paymentProvider.createCheckout({
    reference: request.reference,
    amountCents: request.amountCents,
    currency: request.currency,
    successUrl: `${config.webUrl}/thank-you`,
    cancelUrl: `${config.webUrl}/pay/${request.id}`,
  });

  await db
    .update(requests)
    .set({
      paymentProvider: paymentProvider.name,
      stripeCheckoutSessionId: session.sessionId,
      updatedAt: new Date(),
    })
    .where(eq(requests.id, request.id));

  return { url: session.url };
}

export async function verifyPayment(
  sessionId: string,
): Promise<{ reference: string; paid: boolean }> {
  const [request] = await db
    .select({
      id: requests.id,
      reference: requests.reference,
      paymentStatus: requests.paymentStatus,
    })
    .from(requests)
    .where(eq(requests.stripeCheckoutSessionId, sessionId))
    .limit(1);

  if (!request) {
    throw new HttpError(404, "Unknown payment session");
  }

  if (request.paymentStatus === "paid") {
    return { reference: request.reference, paid: true };
  }

  const paid = await paymentProvider.isPaid(sessionId);

  if (!paid) {
    return { reference: request.reference, paid: false };
  }

  const now = new Date();

  await db
    .update(requests)
    .set({
      paymentStatus: "paid",
      paidAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(requests.id, request.id),
        eq(requests.paymentStatus, "unpaid"),
      ),
    );

  return { reference: request.reference, paid: true };
}
