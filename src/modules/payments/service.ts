import { and, eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { pendingCheckouts } from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";
import { paymentProvider } from "../../lib/payments/index.js";

function isExpired(checkout: { status: string; expiresAt: Date }): boolean {
  return (
    checkout.status === "expired" ||
    checkout.expiresAt.getTime() <= Date.now()
  );
}

async function markExpired(pendingCheckoutId: string): Promise<void> {
  await db
    .update(pendingCheckouts)
    .set({ status: "expired" })
    .where(
      and(
        eq(pendingCheckouts.id, pendingCheckoutId),
        eq(pendingCheckouts.status, "open"),
      ),
    );
}

export async function createCheckoutForRequest(
  pendingCheckoutId: string,
): Promise<{ url: string }> {
  const [checkout] = await db
    .select({
      id: pendingCheckouts.id,
      reference: pendingCheckouts.reference,
      amountCents: pendingCheckouts.amountCents,
      currency: pendingCheckouts.currency,
      status: pendingCheckouts.status,
      expiresAt: pendingCheckouts.expiresAt,
    })
    .from(pendingCheckouts)
    .where(eq(pendingCheckouts.id, pendingCheckoutId))
    .limit(1);

  if (!checkout) {
    throw new HttpError(404, "Pending checkout not found");
  }

  if (checkout.status === "paid") {
    throw new HttpError(409, "Checkout is already paid");
  }

  if (isExpired(checkout)) {
    if (checkout.status === "open") {
      await markExpired(checkout.id);
    }

    throw new HttpError(409, "Checkout has expired");
  }

  const session = await paymentProvider.createCheckout({
    reference: checkout.reference,
    amountCents: checkout.amountCents,
    currency: checkout.currency,
    successUrl: `${config.webUrl}/thank-you`,
    cancelUrl: `${config.webUrl}/pay/${checkout.id}`,
  });

  await db
    .update(pendingCheckouts)
    .set({ stripeSessionId: session.sessionId })
    .where(
      and(
        eq(pendingCheckouts.id, checkout.id),
        eq(pendingCheckouts.status, "open"),
      ),
    );

  return { url: session.url };
}

export async function verifyPayment(
  sessionId: string,
): Promise<{ reference: string; paid: boolean; status: string }> {
  const [checkout] = await db
    .select({
      reference: pendingCheckouts.reference,
      status: pendingCheckouts.status,
    })
    .from(pendingCheckouts)
    .where(eq(pendingCheckouts.stripeSessionId, sessionId))
    .limit(1);

  if (!checkout) {
    throw new HttpError(404, "Unknown payment session");
  }

  return {
    reference: checkout.reference,
    paid: checkout.status === "paid",
    status: checkout.status,
  };
}
