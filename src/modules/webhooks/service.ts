import { randomInt } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  applicants,
  orderEvents,
  orderItems,
  orders,
  pendingCheckouts,
} from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";

function generateOrderNumber(): string {
  const year = new Date().getUTCFullYear();
  const suffix = randomInt(0, 1_000_000).toString().padStart(6, "0");

  return `VISA-${year}-${suffix}`;
}

export async function completePendingCheckout(
  sessionId: string,
): Promise<{ orderNumber: string; created: boolean }> {
  const result = await db.transaction(async (tx) => {
    const [checkout] = await tx
      .select()
      .from(pendingCheckouts)
      .where(eq(pendingCheckouts.stripeSessionId, sessionId))
      .limit(1);

    if (!checkout) {
      return {
        ok: false as const,
        error: new HttpError(404, "Unknown payment session"),
      };
    }

    if (checkout.status === "paid") {
      const [order] = await tx
        .select({ orderNumber: orders.orderNumber })
        .from(orders)
        .where(eq(orders.pendingCheckoutId, checkout.id))
        .limit(1);

      if (!order) {
        throw new Error("Paid pending checkout has no order");
      }

      return {
        ok: true as const,
        orderNumber: order.orderNumber,
        created: false,
      };
    }

    if (checkout.status === "expired") {
      return {
        ok: false as const,
        error: new HttpError(409, "Checkout expired"),
      };
    }

    if (checkout.expiresAt.getTime() <= Date.now()) {
      await tx
        .update(pendingCheckouts)
        .set({ status: "expired" })
        .where(
          and(
            eq(pendingCheckouts.id, checkout.id),
            eq(pendingCheckouts.status, "open"),
          ),
        );

      console.error(`Pending checkout expired: ${checkout.reference}`);

      return {
        ok: false as const,
        error: new HttpError(409, "Checkout expired"),
      };
    }

    const [markedPaid] = await tx
      .update(pendingCheckouts)
      .set({ status: "paid" })
      .where(
        and(
          eq(pendingCheckouts.id, checkout.id),
          eq(pendingCheckouts.status, "open"),
        ),
      )
      .returning({ id: pendingCheckouts.id });

    if (!markedPaid) {
      const [reloaded] = await tx
        .select()
        .from(pendingCheckouts)
        .where(eq(pendingCheckouts.id, checkout.id))
        .limit(1);

      if (!reloaded) {
        throw new Error("Pending checkout disappeared during completion");
      }

      if (reloaded.status === "paid") {
        const [order] = await tx
          .select({ orderNumber: orders.orderNumber })
          .from(orders)
          .where(eq(orders.pendingCheckoutId, reloaded.id))
          .limit(1);

        if (!order) {
          throw new Error("Paid pending checkout has no order");
        }

        return {
          ok: true as const,
          orderNumber: order.orderNumber,
          created: false,
        };
      }

      if (reloaded.status === "expired") {
        return {
          ok: false as const,
          error: new HttpError(409, "Checkout expired"),
        };
      }

      throw new Error("Pending checkout is not open");
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

    const applicantNames = travellers.map((entry) => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error("Invalid traveller entry");
      }

      const { first_name: firstName, surname } = entry as Record<
        string,
        unknown
      >;

      if (typeof firstName !== "string" || typeof surname !== "string") {
        throw new Error("Invalid traveller name");
      }

      return { firstName, surname };
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
        .onConflictDoNothing({ target: orders.orderNumber })
        .returning({ id: orders.id, orderNumber: orders.orderNumber });

      if (inserted) {
        order = inserted;
        break;
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
        totalAmountCents:
          checkout.governmentFeeCents * checkout.travellerCount,
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
      applicantNames.map((name, index) => ({
        orderId: createdOrder.id,
        sortOrder: index + 1,
        firstName: name.firstName,
        surname: name.surname,
        answers: {},
        status: "incomplete",
      })),
    );

    await tx.insert(orderEvents).values({
      orderId: createdOrder.id,
      fromStatus: null,
      toStatus: "paid",
      actorType: "stripe",
      note: "Payment confirmed",
    });

    return {
      ok: true as const,
      orderNumber: createdOrder.orderNumber,
      created: true,
    };
  });

  if (!result.ok) {
    throw result.error;
  }

  return { orderNumber: result.orderNumber, created: result.created };
}
