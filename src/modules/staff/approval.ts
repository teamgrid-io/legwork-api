import { randomInt } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  applicants,
  auditLogs,
  orderEvents,
  orderItems,
  orders,
  payments,
  pendingCheckouts,
} from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CheckoutRow = typeof pendingCheckouts.$inferSelect;

export type PaymentStatus = "succeeded" | "review_required" | "order_created";

const REVIEW_REASON_CODES = [
  "late_payment",
  "amount_mismatch",
  "currency_mismatch",
] as const;

const APPROVAL_KEY_CONSTRAINT = "payments_approval_idempotency_key_uq";

export interface ApprovalResult {
  readonly paymentId: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly created: boolean;
}

export interface PaymentFilter {
  readonly status?: PaymentStatus | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface PaymentSummary {
  readonly id: string;
  readonly pendingCheckoutId: string;
  readonly reference: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly status: string;
  readonly paidAt: Date;
  readonly createdAt: Date;
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
}

export interface PaymentListResult {
  readonly payments: PaymentSummary[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

function generateOrderNumber(): string {
  const year = new Date().getUTCFullYear();
  const suffix = randomInt(0, 1_000_000).toString().padStart(6, "0");

  return `VISA-${year}-${suffix}`;
}

/**
 * True when the failure is a unique violation on the approval key index.
 *
 * drizzle wraps driver errors (the pg error sits on `cause`), so the chain is
 * walked. A 23505 only counts as an approval-key conflict when it names
 * `payments_approval_idempotency_key_uq`, either in `constraint` or in the
 * message. Any other unique violation is left alone and surfaces as-is. This must
 * never turn the approval-key race into a 500.
 */
export function isApprovalKeyConflict(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || typeof current !== "object") {
      return false;
    }

    const node = current as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };

    if (node.code === "23505") {
      if (node.constraint === APPROVAL_KEY_CONSTRAINT) {
        return true;
      }

      if (
        typeof node.message === "string" &&
        node.message.includes(APPROVAL_KEY_CONSTRAINT)
      ) {
        return true;
      }
    }

    current = node.cause;
  }

  return false;
}

/**
 * Original review reason codes for the payment, read from its
 * `payment.review_required` audit row and whitelisted, so `reason` never carries
 * free text. A missing row yields an empty array.
 */
async function readReviewReasons(
  tx: Tx,
  paymentId: string,
): Promise<string[]> {
  const [review] = await tx
    .select({ metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.entityType, "payment"),
        eq(auditLogs.entityId, paymentId),
        eq(auditLogs.action, "payment.review_required"),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);

  const raw = (review?.metadata as { reason?: unknown } | undefined)?.reason;

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter(
    (code): code is string =>
      typeof code === "string" &&
      (REVIEW_REASON_CODES as readonly string[]).includes(code),
  );
}

/**
 * Order creation from the pending_checkouts snapshot.
 *
 * This mirrors `createOrderFromCheckout` in src/modules/webhooks/service.ts,
 * which is private and whose file is out of scope for this change. The inserts,
 * collision handling, and `actorType` are identical; the order of operations is
 * kept the same so both paths produce the same shape.
 *
 * Follow-up: export the webhook helper and delete this copy.
 */
async function createOrderFromCheckoutTx(
  tx: Tx,
  checkout: CheckoutRow,
  actorType: "stripe" | "staff",
): Promise<{ id: string; orderNumber: string; created: boolean }> {
  const [existing] = await tx
    .select({ id: orders.id, orderNumber: orders.orderNumber })
    .from(orders)
    .where(eq(orders.pendingCheckoutId, checkout.id))
    .limit(1);

  if (existing) {
    return {
      id: existing.id,
      orderNumber: existing.orderNumber,
      created: false,
    };
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

  const applicantDetails = travellers.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("Invalid traveller entry");
    }

    const {
      first_name: firstName,
      surname,
      gender,
      maritalStatus,
    } = entry as Record<string, unknown>;

    if (typeof firstName !== "string" || typeof surname !== "string") {
      throw new Error("Invalid traveller name");
    }

    if (typeof gender !== "string" || typeof maritalStatus !== "string") {
      throw new Error("Invalid traveller details");
    }

    return { firstName, surname, gender, maritalStatus };
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
      // Catches UNIQUE(order_number) and UNIQUE(pending_checkout_id).
      .onConflictDoNothing()
      .returning({ id: orders.id, orderNumber: orders.orderNumber });

    if (inserted) {
      order = inserted;
      break;
    }

    const [raced] = await tx
      .select({ id: orders.id, orderNumber: orders.orderNumber })
      .from(orders)
      .where(eq(orders.pendingCheckoutId, checkout.id))
      .limit(1);

    if (raced) {
      return {
        id: raced.id,
        orderNumber: raced.orderNumber,
        created: false,
      };
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
      totalAmountCents: checkout.governmentFeeCents * checkout.travellerCount,
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
    applicantDetails.map((applicant, index) => ({
      orderId: createdOrder.id,
      sortOrder: index + 1,
      firstName: applicant.firstName,
      surname: applicant.surname,
      answers: {
        gender: applicant.gender,
        marital_status: applicant.maritalStatus,
      },
      status: "incomplete",
    })),
  );

  await tx.insert(orderEvents).values({
    orderId: createdOrder.id,
    fromStatus: null,
    toStatus: "paid",
    actorType,
    note: "Payment confirmed",
  });

  return {
    id: createdOrder.id,
    orderNumber: createdOrder.orderNumber,
    created: true,
  };
}

/**
 * T3: staff approval of a `review_required` payment.
 *
 * One transaction: guarded transition, order from the checkout snapshot, audit
 * row. The amount and currency always come from the snapshot row, never from the
 * request body or the payment row.
 */
export async function approvePayment(
  paymentId: string,
  staffId: string,
  idempotencyKey: string,
  note: string | undefined,
): Promise<ApprovalResult> {
  try {
    return await db.transaction(async (tx) => {
      const now = new Date();

      // T3 guard: only a payment still awaiting review can be approved.
      const [approved] = await tx
        .update(payments)
        .set({
          status: "order_created",
          approvedBy: staffId,
          approvedAt: now,
          approvalIdempotencyKey: idempotencyKey,
          updatedAt: now,
        })
        .where(
          and(
            eq(payments.id, paymentId),
            eq(payments.status, "review_required"),
          ),
        )
        .returning({
          id: payments.id,
          pendingCheckoutId: payments.pendingCheckoutId,
        });

      if (!approved) {
        const [existing] = await tx
          .select({
            id: payments.id,
            status: payments.status,
            pendingCheckoutId: payments.pendingCheckoutId,
            approvalIdempotencyKey: payments.approvalIdempotencyKey,
          })
          .from(payments)
          .where(eq(payments.id, paymentId))
          .limit(1);

        if (!existing) {
          throw new HttpError(404, "Payment not found");
        }

        // Replay of the same approval: return the original result, no new order.
        if (
          existing.status === "order_created" &&
          existing.approvalIdempotencyKey === idempotencyKey
        ) {
          const [order] = await tx
            .select({ id: orders.id, orderNumber: orders.orderNumber })
            .from(orders)
            .where(eq(orders.pendingCheckoutId, existing.pendingCheckoutId))
            .limit(1);

          if (!order) {
            throw new Error("Approved payment has no order");
          }

          return {
            paymentId: existing.id,
            orderId: order.id,
            orderNumber: order.orderNumber,
            created: false,
          };
        }

        // Already turned into an order by a different approval key.
        if (
          existing.status === "order_created" &&
          existing.approvalIdempotencyKey !== null
        ) {
          throw new HttpError(409, "Payment has already been approved");
        }

        // Different key, or a payment that is not awaiting review.
        throw new HttpError(409, "Payment is not awaiting review");
      }

      const [checkout] = await tx
        .select()
        .from(pendingCheckouts)
        .where(eq(pendingCheckouts.id, approved.pendingCheckoutId))
        .limit(1)
        .for("update");

      if (!checkout) {
        throw new Error("review_required payment has no pending checkout");
      }

      const reason = await readReviewReasons(tx, paymentId);
      const order = await createOrderFromCheckoutTx(tx, checkout, "staff");

      await tx.insert(auditLogs).values({
        actorType: "staff",
        actorId: staffId,
        action: "payment.approved",
        entityType: "payment",
        entityId: paymentId,
        metadata: {
          previous_status: "review_required",
          new_status: "order_created",
          reason,
          ...(note === undefined ? {} : { note }),
          idempotency_key: idempotencyKey,
        },
      });

      return {
        paymentId,
        orderId: order.id,
        orderNumber: order.orderNumber,
        created: order.created,
      };
    });
  } catch (error) {
    if (isApprovalKeyConflict(error)) {
      throw new HttpError(409, "Idempotency-Key already used");
    }

    throw error;
  }
}

/**
 * Staff payment list. Newest first, stable across equal timestamps via the id
 * tiebreak. `total` is the count under the same filter, not the page size.
 */
export async function listPayments(
  filter: PaymentFilter,
): Promise<PaymentListResult> {
  const predicate =
    filter.status === undefined
      ? undefined
      : eq(payments.status, filter.status);

  const rows = await db
    .select({
      id: payments.id,
      pendingCheckoutId: payments.pendingCheckoutId,
      reference: pendingCheckouts.reference,
      amountCents: payments.amountCents,
      currency: payments.currency,
      status: payments.status,
      paidAt: payments.paidAt,
      createdAt: payments.createdAt,
      approvedBy: payments.approvedBy,
      approvedAt: payments.approvedAt,
    })
    .from(payments)
    .innerJoin(
      pendingCheckouts,
      eq(payments.pendingCheckoutId, pendingCheckouts.id),
    )
    .where(predicate)
    .orderBy(desc(payments.createdAt), desc(payments.id))
    .limit(filter.limit)
    .offset(filter.offset);

  const [totals] = await db
    .select({ value: count() })
    .from(payments)
    .where(predicate);

  return {
    payments: rows,
    total: Number(totals?.value ?? 0),
    limit: filter.limit,
    offset: filter.offset,
  };
}
