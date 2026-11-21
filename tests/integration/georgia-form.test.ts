import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  applicants,
  auditLogs,
  countries,
  customers,
  orders,
  pendingCheckouts,
  visaProducts,
} from "../../src/db/schema.js";
import { signCustomerToken } from "../../src/modules/customer/token.js";
import { getBaseUrl } from "../helpers/server.js";

const ALLOWED_FIELD_TYPES = new Set([
  "text",
  "email",
  "phone",
  "date",
  "select",
  "radio",
  "checkbox",
  "country",
]);

interface FormField {
  fieldKey: string;
  fieldType: string;
}

interface FormGroup {
  fields: FormField[];
}

function fieldsFrom(body: unknown): FormField[] {
  assert.ok(Array.isArray(body));
  return (body as FormGroup[]).flatMap((group) => group.fields);
}

function fixtureToken(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

export const suiteTests: Array<Promise<void>> = [
  test("Georgia product and applicant forms expose the same seeded field keys", async () => {
    const [georgia] = await db
      .select({
        countryId: countries.id,
        productId: visaProducts.id,
        formVersion: visaProducts.currentFormVersion,
      })
      .from(countries)
      .innerJoin(
        visaProducts,
        eq(visaProducts.destinationCountryId, countries.id),
      )
      .where(and(eq(countries.iso2, "GE"), eq(visaProducts.active, true)))
      .limit(1);

    assert.ok(georgia, "the seeded active Georgia product must exist");

    const productFormResponse = await fetch(
      `${getBaseUrl()}/api/v1/visaProducts/${georgia.productId}/form`,
    );
    assert.equal(productFormResponse.status, 200);
    const productGroups: unknown = await productFormResponse.json();
    const productFields = fieldsFrom(productGroups);
    assert.ok(productFields.length > 0, "Georgia form groups must be non-empty");

    for (const field of productFields) {
      assert.ok(
        ALLOWED_FIELD_TYPES.has(field.fieldType),
        `unsupported field type: ${field.fieldType}`,
      );
    }

    const tokenPart = fixtureToken();
    const customerEmail = `test-georgia-form-${tokenPart}@example.test`;
    let customerId: string | undefined;
    let checkoutId: string | undefined;
    let orderId: string | undefined;
    let applicantId: string | undefined;

    try {
      const [customer] = await db
        .insert(customers)
        .values({
          email: customerEmail,
          name: "Georgia Form Test",
          phone: "+15550100000",
          activatedAt: new Date(),
        })
        .returning({ id: customers.id });

      assert.ok(customer);
      customerId = customer.id;

      const [checkout] = await db
        .insert(pendingCheckouts)
        .values({
          reference: `TEST-GEORGIA-CHECKOUT-${tokenPart}`,
          visaProductId: georgia.productId,
          passportCountryId: georgia.countryId,
          travelDate: "2027-06-01",
          travellerCount: 1,
          travellers: [
            {
              first_name: "Test",
              surname: "Traveller",
              gender: "female",
              maritalStatus: "single",
            },
          ],
          contactEmail: customerEmail,
          contactPhone: "+15550100000",
          formVersion: georgia.formVersion,
          governmentFeeCents: 1000,
          legworkFeeCents: 500,
          amountCents: 1500,
          currency: "USD",
          status: "paid",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        })
        .returning({ id: pendingCheckouts.id });

      assert.ok(checkout);
      checkoutId = checkout.id;

      const [order] = await db
        .insert(orders)
        .values({
          orderNumber: `TEST-GEORGIA-ORDER-${tokenPart}`,
          pendingCheckoutId: checkout.id,
          customerId: customer.id,
          visaProductId: georgia.productId,
          passportCountryId: georgia.countryId,
          travelDate: "2027-06-01",
          travellerCount: 1,
          contactEmail: customerEmail,
          contactPhone: "+15550100000",
          formVersion: georgia.formVersion,
          amountCents: 1500,
          currency: "USD",
          status: "paid",
          paidAt: new Date(),
        })
        .returning({ id: orders.id });

      assert.ok(order);
      orderId = order.id;

      const [applicant] = await db
        .insert(applicants)
        .values({
          orderId: order.id,
          sortOrder: 1,
          firstName: "Test",
          surname: "Traveller",
          answers: {},
          status: "incomplete",
        })
        .returning({ id: applicants.id });

      assert.ok(applicant);
      applicantId = applicant.id;

      const customerToken = await signCustomerToken(customer.id);
      const applicantFormResponse = await fetch(
        `${getBaseUrl()}/api/v1/applicants/${applicant.id}/form`,
        { headers: { authorization: `Bearer ${customerToken}` } },
      );
      assert.equal(applicantFormResponse.status, 200);
      const applicantGroups: unknown = await applicantFormResponse.json();
      const applicantFields = fieldsFrom(applicantGroups);

      assert.deepEqual(
        applicantFields.map((field) => field.fieldKey).sort(),
        productFields.map((field) => field.fieldKey).sort(),
      );
    } finally {
      if (applicantId) {
        await db
          .delete(auditLogs)
          .where(
            and(
              eq(auditLogs.entityType, "applicant"),
              eq(auditLogs.entityId, applicantId),
            ),
          );
        await db.delete(applicants).where(eq(applicants.id, applicantId));
      }

      if (orderId) {
        await db.delete(orders).where(eq(orders.id, orderId));
      }

      if (checkoutId) {
        await db
          .delete(pendingCheckouts)
          .where(eq(pendingCheckouts.id, checkoutId));
      }

      if (customerId) {
        await db
          .delete(auditLogs)
          .where(
            and(
              eq(auditLogs.entityType, "customer"),
              eq(auditLogs.entityId, customerId),
            ),
          );
        await db.delete(customers).where(inArray(customers.id, [customerId]));
      }
    }
  }),
];
