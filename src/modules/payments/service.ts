import { and, eq, notExists } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { payments, pendingCheckouts } from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";
import { paymentProvider } from "../../lib/payments/index.js";
import type { ExistingCheckout } from "../../lib/payments/types.js";

function isExpired(checkout: { status: string; expiresAt: Date }): boolean {
  return (
    checkout.status === "expired" ||
    checkout.expiresAt.getTime() <= Date.now()
  );
}

export async function createCheckoutForRequest(
  pendingCheckoutId: string,
): Promise<{ url: string }> {
  return db.transaction(async (tx) => {
    const [checkout] = await tx
      .select({
        id: pendingCheckouts.id,
        reference: pendingCheckouts.reference,
        amountCents: pendingCheckouts.amountCents,
        currency: pendingCheckouts.currency,
        status: pendingCheckouts.status,
        expiresAt: pendingCheckouts.expiresAt,
        createdAt: pendingCheckouts.createdAt,
        stripeSessionId: pendingCheckouts.stripeSessionId,
      })
      .from(pendingCheckouts)
      .where(eq(pendingCheckouts.id, pendingCheckoutId))
      .limit(1)
      .for("update");

    if (!checkout) {
      throw new HttpError(404, "Pending checkout not found");
    }

    if (checkout.status === "paid") {
      throw new HttpError(409, "Checkout is already paid");
    }

    if (isExpired(checkout)) {
      if (checkout.status === "open") {
        await tx
          .update(pendingCheckouts)
          .set({ status: "expired" })
          .where(
            and(
              eq(pendingCheckouts.id, checkout.id),
              eq(pendingCheckouts.status, "open"),
            ),
          );
      }

      throw new HttpError(409, "Checkout has expired");
    }

    if (checkout.stripeSessionId) {
      let existing: ExistingCheckout | null;

      try {
        existing = await paymentProvider.getCheckout(checkout.stripeSessionId);
      } catch {
        throw new HttpError(503, "Payment service unavailable, try again");
      }

      if (existing?.status === "open" && existing.url) {
        // Option A: align to Stripe's real expiry, capped at created_at + 31 min.
        // Stripe's value can only be earlier (legacy sessions created without an
        // explicit expires_at), never later than the ceiling for new sessions.
        // Skipped when the checkout already has a payments row: the deadline is
        // the input to the late/mismatch decision.
        const stripeDeadlineMs = existing.expiresAt * 1000;
        const localCeilingMs = checkout.createdAt.getTime() + 31 * 60 * 1000;
        const aligned = new Date(Math.min(stripeDeadlineMs, localCeilingMs));

        await tx
          .update(pendingCheckouts)
          .set({ expiresAt: aligned })
          .where(
            and(
              eq(pendingCheckouts.id, checkout.id),
              notExists(
                tx
                  .select({ id: payments.id })
                  .from(payments)
                  .where(eq(payments.pendingCheckoutId, checkout.id)),
              ),
            ),
          );

        // Reason: Stripe can still report "open" while the aligned deadline has
        // already passed (expiry propagation delay or clock skew). Never hand
        // back a dead URL; use the same expired handling as an expired checkout.
        if (aligned.getTime() <= Date.now()) {
          if (checkout.status === "open") {
            await tx
              .update(pendingCheckouts)
              .set({ status: "expired" })
              .where(
                and(
                  eq(pendingCheckouts.id, checkout.id),
                  eq(pendingCheckouts.status, "open"),
                ),
              );
          }

          throw new HttpError(409, "Checkout has expired");
        }

        return { url: existing.url };
      }

      if (existing?.status === "complete") {
        throw new HttpError(409, "Checkout is already paid");
      }

      // The stored session is expired (or the provider cannot inspect it):
      // fall through and create a replacement.
    }

    const session = await paymentProvider.createCheckout({
      reference: checkout.reference,
      amountCents: checkout.amountCents,
      currency: checkout.currency,
      successUrl: `${config.webUrl}/thank-you`,
      cancelUrl: `${config.webUrl}/pay/${checkout.id}`,
      idempotencyKey: `checkout-${checkout.id}-${checkout.stripeSessionId ?? "initial"}`,
    });

    const [updated] = await tx
      .update(pendingCheckouts)
      .set({
        stripeSessionId: session.sessionId,
        // Stripe's returned value, not the requested now + 31 minutes.
        expiresAt: new Date(session.expiresAt * 1000),
      })
      .where(
        and(
          eq(pendingCheckouts.id, checkout.id),
          eq(pendingCheckouts.status, "open"),
        ),
      )
      .returning({ id: pendingCheckouts.id });

    if (!updated) {
      throw new HttpError(409, "Checkout is already paid");
    }

    return { url: session.url };
  });
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
