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
  documents,
  formFields,
  orderEvents,
  orders,
  payments,
  pendingCheckouts,
  visaProducts,
} from "../../src/db/schema.js";
import { storage } from "../../src/lib/storage.js";
import { signCustomerToken } from "../../src/modules/customer/token.js";
import { getBaseUrl } from "../helpers/server.js";

const DOCUMENT_TYPE = "passport_scan";
const CONFLICT_MESSAGE = "A document of this type is already being uploaded";

interface FixtureData {
  customerIds: string[];
  productIds: string[];
  checkoutIds: string[];
  orderIds: string[];
  applicantIds: string[];
}

function emptyFixture(): FixtureData {
  return {
    customerIds: [],
    productIds: [],
    checkoutIds: [],
    orderIds: [],
    applicantIds: [],
  };
}

function suffix(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

async function firstCountryId(): Promise<string> {
  const [country] = await db
    .select({ id: countries.id })
    .from(countries)
    .limit(1);

  if (!country) {
    throw new Error(
      "legwork_test has no countries row; seed the test database first",
    );
  }

  return country.id;
}

async function createCustomer(data: FixtureData): Promise<string> {
  const email = `test-docuniq-${suffix()}@example.test`;

  const [customer] = await db
    .insert(customers)
    .values({
      email,
      name: "Document Uniqueness Customer",
      phone: "+15550100000",
      activatedAt: new Date(),
    })
    .returning({ id: customers.id });

  if (!customer) {
    throw new Error("Could not insert the test customer");
  }

  data.customerIds.push(customer.id);

  return customer.id;
}

async function createProduct(
  data: FixtureData,
  countryId: string,
): Promise<string> {
  const [product] = await db
    .insert(visaProducts)
    .values({
      destinationCountryId: countryId,
      name: `TEST-DOCUNIQ-PRODUCT-${suffix()}`,
      visaType: "single_entry",
      stayDays: 30,
      processingDaysMin: 1,
      processingDaysMax: 2,
      governmentFeeCents: 1000,
      legworkFeeCents: 500,
      currency: "USD",
      requiredDocuments: [DOCUMENT_TYPE],
      currentFormVersion: 1,
      active: true,
    })
    .returning({ id: visaProducts.id });

  if (!product) {
    throw new Error("Could not insert the test visa product");
  }

  data.productIds.push(product.id);

  return product.id;
}

async function createApplicant(
  data: FixtureData,
  input: { customerId: string; productId: string; countryId: string },
): Promise<string> {
  const token = suffix();

  const [checkout] = await db
    .insert(pendingCheckouts)
    .values({
      reference: `TEST-DOCUNIQ-CHECKOUT-${token}`,
      visaProductId: input.productId,
      passportCountryId: input.countryId,
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
      contactEmail: `test-docuniq-${token}@example.test`,
      contactPhone: "+15550100000",
      formVersion: 1,
      governmentFeeCents: 1000,
      legworkFeeCents: 500,
      amountCents: 1500,
      currency: "USD",
      status: "paid",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning({ id: pendingCheckouts.id });

  if (!checkout) {
    throw new Error("Could not insert the test pending checkout");
  }

  data.checkoutIds.push(checkout.id);

  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `TEST-DOCUNIQ-ORDER-${token}`,
      pendingCheckoutId: checkout.id,
      customerId: input.customerId,
      visaProductId: input.productId,
      passportCountryId: input.countryId,
      travelDate: "2027-06-01",
      travellerCount: 1,
      contactEmail: `test-docuniq-${token}@example.test`,
      contactPhone: "+15550100000",
      formVersion: 1,
      amountCents: 1500,
      currency: "USD",
      status: "paid",
      paidAt: new Date(),
    })
    .returning({ id: orders.id });

  if (!order) {
    throw new Error("Could not insert the test order");
  }

  data.orderIds.push(order.id);

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

  if (!applicant) {
    throw new Error("Could not insert the test applicant");
  }

  data.applicantIds.push(applicant.id);

  return applicant.id;
}

/** One customer, product, order, and applicant, ready for uploads. */
async function createUploadFixture(data: FixtureData): Promise<{
  applicantId: string;
  token: string;
}> {
  const countryId = await firstCountryId();
  const productId = await createProduct(data, countryId);
  const customerId = await createCustomer(data);
  const applicantId = await createApplicant(data, {
    customerId,
    productId,
    countryId,
  });
  const token = await signCustomerToken(customerId);

  return { applicantId, token };
}

async function cleanup(data: FixtureData): Promise<void> {
  if (data.applicantIds.length > 0) {
    const documentRows = await db
      .select({ id: documents.id, storageKey: documents.storageKey })
      .from(documents)
      .where(inArray(documents.applicantId, data.applicantIds));

    if (documentRows.length > 0) {
      await db
        .delete(auditLogs)
        .where(
          inArray(
            auditLogs.entityId,
            documentRows.map((document) => document.id),
          ),
        );
      await db
        .delete(documents)
        .where(inArray(documents.applicantId, data.applicantIds));

      for (const document of documentRows) {
        await storage.delete(document.storageKey).catch(() => {
          // The losing concurrent upload already removed its own file.
        });
      }
    }

    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.entityId, data.applicantIds));
    await db.delete(applicants).where(inArray(applicants.id, data.applicantIds));
  }

  if (data.orderIds.length > 0) {
    await db
      .delete(orderEvents)
      .where(inArray(orderEvents.orderId, data.orderIds));
    await db.delete(orders).where(inArray(orders.id, data.orderIds));
  }

  if (data.checkoutIds.length > 0) {
    await db
      .delete(payments)
      .where(inArray(payments.pendingCheckoutId, data.checkoutIds));
    await db
      .delete(pendingCheckouts)
      .where(inArray(pendingCheckouts.id, data.checkoutIds));
  }

  if (data.productIds.length > 0) {
    await db
      .delete(formFields)
      .where(inArray(formFields.visaProductId, data.productIds));
    await db
      .delete(visaProducts)
      .where(inArray(visaProducts.id, data.productIds));
  }

  if (data.customerIds.length > 0) {
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.entityId, data.customerIds));
    await db.delete(customers).where(inArray(customers.id, data.customerIds));
  }
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function postDocument(
  applicantId: string,
  token: string,
): Promise<JsonResponse> {
  const form = new FormData();

  form.append("documentType", DOCUMENT_TYPE);
  form.append(
    "file",
    new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x00])], {
      type: "image/jpeg",
    }),
    "passport.jpg",
  );

  const response = await fetch(
    `${getBaseUrl()}/api/v1/applicants/${applicantId}/documents`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    },
  );
  const text = await response.text();

  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function rowsFor(
  applicantId: string,
): Promise<Array<{ id: string; status: string }>> {
  return db
    .select({ id: documents.id, status: documents.status })
    .from(documents)
    .where(
      and(
        eq(documents.applicantId, applicantId),
        eq(documents.documentType, DOCUMENT_TYPE),
      ),
    );
}

export const suiteTests: Array<Promise<void>> = [
  test("two concurrent uploads of one type: exactly one 201, one 409, one row", async () => {
    const data = emptyFixture();

    try {
      const { applicantId, token } = await createUploadFixture(data);

      const [first, second] = await Promise.all([
        postDocument(applicantId, token),
        postDocument(applicantId, token),
      ]);
      const statuses = [first.status, second.status].sort((a, b) => a - b);

      assert.deepEqual(statuses, [201, 409]);

      const conflict = [first, second].find(
        (response) => response.status === 409,
      );

      assert.ok(conflict);
      assert.equal(conflict.body.error, CONFLICT_MESSAGE);

      const rows = await rowsFor(applicantId);

      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, "pending_scan");
    } finally {
      await cleanup(data);
    }
  }),

  test("a second upload of the same type is rejected while the first is active", async () => {
    const data = emptyFixture();

    try {
      const { applicantId, token } = await createUploadFixture(data);

      const first = await postDocument(applicantId, token);

      assert.equal(first.status, 201);
      assert.equal(first.body.status, "pending_scan");

      const second = await postDocument(applicantId, token);

      assert.equal(second.status, 409);
      assert.equal(second.body.error, CONFLICT_MESSAGE);

      const rows = await rowsFor(applicantId);

      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, "pending_scan");
    } finally {
      await cleanup(data);
    }
  }),

  test("a new upload succeeds after the previous document of that type is rejected", async () => {
    const data = emptyFixture();

    try {
      const { applicantId, token } = await createUploadFixture(data);

      const first = await postDocument(applicantId, token);

      assert.equal(first.status, 201);

      await db
        .update(documents)
        .set({ status: "rejected", rejectionReason: "test rejection" })
        .where(eq(documents.applicantId, applicantId));

      const second = await postDocument(applicantId, token);

      assert.equal(second.status, 201);
      assert.equal(second.body.status, "pending_scan");

      const rows = await rowsFor(applicantId);

      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map((row) => row.status).sort(),
        ["pending_scan", "rejected"],
      );
    } finally {
      await cleanup(data);
    }
  }),
];
