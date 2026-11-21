import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applicants, orders } from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";

/**
 * Enforce that an applicant belongs to an order owned by this customer.
 *
 * A missing applicant and an applicant owned by somebody else are deliberately
 * indistinguishable: both throw the same 404, so the response cannot be used to
 * probe for applicant ids.
 */
export async function assertApplicantOwnedByCustomer(input: {
  applicantId: string;
  customerId: string;
}): Promise<void> {
  const [row] = await db
    .select({ id: applicants.id })
    .from(applicants)
    .innerJoin(orders, eq(applicants.orderId, orders.id))
    .where(
      and(
        eq(applicants.id, input.applicantId),
        eq(orders.customerId, input.customerId),
      ),
    )
    .limit(1);

  if (!row) {
    throw new HttpError(404, "Applicant not found");
  }
}
