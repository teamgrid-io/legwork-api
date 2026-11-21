import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { config } from "../../src/config.js";
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
import { signStaffToken } from "../../src/modules/staff/token.js";
import { getBaseUrl } from "../helpers/server.js";

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

async function createCustomer(
  data: FixtureData,
  name: string,
): Promise<string> {
  const [customer] = await db
    .insert(customers)
    .values({
      email: `test-own-${suffix()}@example.test`,
      name,
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
      name: `TEST-OWN-PRODUCT-${suffix()}`,
      visaType: "single_entry",
      stayDays: 30,
      processingDaysMin: 1,
      processingDaysMax: 2,
      governmentFeeCents: 1000,
      legworkFeeCents: 500,
      currency: "USD",
      requiredDocuments: ["passport_scan"],
      currentFormVersion: 1,
      active: true,
    })
    .returning({ id: visaProducts.id });

  if (!product) {
    throw new Error("Could not insert the test visa product");
  }

  data.productIds.push(product.id);

  await db.insert(formFields).values({
    visaProductId: product.id,
    formVersion: 1,
    step: "full",
    groupKey: "personal",
    fieldKey: "test_required_text",
    label: "Test required text",
    fieldType: "text",
    required: true,
    options: [],
    sortOrder: 1,
    visibleIf: null,
  });

  return product.id;
}

async function createApplicant(
  data: FixtureData,
  input: {
    customerId: string;
    productId: string;
    countryId: string;
    answers?: Record<string, unknown>;
  },
): Promise<string> {
  const token = suffix();

  const [checkout] = await db
    .insert(pendingCheckouts)
    .values({
      reference: `TEST-OWN-CHECKOUT-${token}`,
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
      contactEmail: `test-own-${token}@example.test`,
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
      orderNumber: `TEST-OWN-ORDER-${token}`,
      pendingCheckoutId: checkout.id,
      customerId: input.customerId,
      visaProductId: input.productId,
      passportCountryId: input.countryId,
      travelDate: "2027-06-01",
      travellerCount: 1,
      contactEmail: `test-own-${token}@example.test`,
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
      answers: input.answers ?? {},
      status: "incomplete",
    })
    .returning({ id: applicants.id });

  if (!applicant) {
    throw new Error("Could not insert the test applicant");
  }

  data.applicantIds.push(applicant.id);

  return applicant.id;
}

async function addVerifiedPassport(applicantId: string): Promise<void> {
  await db.insert(documents).values({
    applicantId,
    documentType: "passport_scan",
    storageKey: `TEST-OWN-DOC-${suffix()}`,
    sha256: "a".repeat(64),
    mimeType: "application/pdf",
    sizeBytes: 1024,
    status: "verified",
  });
}

async function cleanup(data: FixtureData): Promise<void> {
  if (data.applicantIds.length > 0) {
    const documentRows = await db
      .select({ id: documents.id, storageKey: documents.storageKey })
      .from(documents)
      .where(inArray(documents.applicantId, data.applicantIds));

    if (documentRows.length > 0) {
      await db.delete(auditLogs).where(
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
          // Test fixture files may never have been written.
        });
      }
    }

    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.entityId, data.applicantIds));
    await db
      .delete(applicants)
      .where(inArray(applicants.id, data.applicantIds));
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
    await db
      .delete(customers)
      .where(inArray(customers.id, data.customerIds));
  }
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function readJson(response: Response): Promise<JsonResponse> {
  const raw = await response.text();

  return {
    status: response.status,
    body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
  };
}

function authHeaders(
  token?: string,
  legacyToken?: string,
): Record<string, string> {
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(legacyToken ? { "x-applicant-token": legacyToken } : {}),
  };
}

async function putAnswers(
  applicantId: string,
  token?: string,
  legacyToken?: string,
): Promise<JsonResponse> {
  const response = await fetch(
    `${getBaseUrl()}/api/v1/applicants/${applicantId}/answers`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...authHeaders(token, legacyToken),
      },
      body: JSON.stringify({ answers: { test_required_text: "hello" } }),
    },
  );

  return readJson(response);
}

async function postSubmit(
  applicantId: string,
  token?: string,
  legacyToken?: string,
): Promise<JsonResponse> {
  const response = await fetch(
    `${getBaseUrl()}/api/v1/applicants/${applicantId}/submit`,
    {
      method: "POST",
      headers: authHeaders(token, legacyToken),
    },
  );

  return readJson(response);
}

async function postDocument(
  applicantId: string,
  token?: string,
  legacyToken?: string,
): Promise<JsonResponse> {
  const form = new FormData();

  form.append("documentType", "passport_scan");
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
      headers: authHeaders(token, legacyToken),
      body: form,
    },
  );

  return readJson(response);
}

/**
 * Only the documents tests write files. Serializing them keeps the anonymous
 * file-count assertion independent of a concurrent owner upload and its
 * cleanup.
 */
let uploadLock: Promise<unknown> = Promise.resolve();

function withUploadLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = uploadLock.then(fn, fn);

  uploadLock = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
}

async function uploadFileCount(): Promise<number> {
  try {
    return (await readdir(config.uploadDir)).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }

    throw error;
  }
}

export const suiteTests: Array<Promise<void>> = [
  test("answers: owner allowed, other customer 404, no token 401, staff token 401", async () => {
    const data = emptyFixture();

    try {
      const countryId = await firstCountryId();
      const productId = await createProduct(data, countryId);
      const ownerId = await createCustomer(data, "Answers Owner");
      const otherId = await createCustomer(data, "Answers Other");
      const ownedApplicant = await createApplicant(data, {
        customerId: ownerId,
        productId,
        countryId,
      });
      const foreignApplicant = await createApplicant(data, {
        customerId: otherId,
        productId,
        countryId,
      });

      const ownerToken = await signCustomerToken(ownerId);
      const staffToken = await signStaffToken(ownerId);

      const allowed = await putAnswers(ownedApplicant, ownerToken);

      assert.equal(allowed.status, 200);
      assert.equal(allowed.body.applicantId, ownedApplicant);
      assert.deepEqual(allowed.body.savedFields, ["test_required_text"]);

      const foreign = await putAnswers(foreignApplicant, ownerToken);
      const randomApplicant = await putAnswers(randomUUID(), ownerToken);

      assert.equal(foreign.status, 404);
      assert.equal(randomApplicant.status, 404);
      assert.deepEqual(foreign.body, randomApplicant.body);

      assert.equal((await putAnswers(ownedApplicant)).status, 401);
      assert.equal((await putAnswers(ownedApplicant, staffToken)).status, 401);
      assert.equal(
        (await putAnswers(ownedApplicant, undefined, "legacy-applicant-token"))
          .status,
        401,
      );
    } finally {
      await cleanup(data);
    }
  }),

  test("submit: owner allowed, other customer 404, no token 401, staff token 401", async () => {
    const data = emptyFixture();

    try {
      const countryId = await firstCountryId();
      const productId = await createProduct(data, countryId);
      const ownerId = await createCustomer(data, "Submit Owner");
      const otherId = await createCustomer(data, "Submit Other");
      const ownedApplicant = await createApplicant(data, {
        customerId: ownerId,
        productId,
        countryId,
        answers: { test_required_text: "hello" },
      });
      const foreignApplicant = await createApplicant(data, {
        customerId: otherId,
        productId,
        countryId,
        answers: { test_required_text: "hello" },
      });

      await addVerifiedPassport(ownedApplicant);

      const ownerToken = await signCustomerToken(ownerId);
      const staffToken = await signStaffToken(ownerId);

      const allowed = await postSubmit(ownedApplicant, ownerToken);

      assert.equal(allowed.status, 200);
      assert.equal(allowed.body.applicantId, ownedApplicant);
      assert.equal(allowed.body.status, "complete");

      const foreign = await postSubmit(foreignApplicant, ownerToken);
      const randomApplicant = await postSubmit(randomUUID(), ownerToken);

      assert.equal(foreign.status, 404);
      assert.equal(randomApplicant.status, 404);
      assert.deepEqual(foreign.body, randomApplicant.body);

      assert.equal((await postSubmit(ownedApplicant)).status, 401);
      assert.equal((await postSubmit(ownedApplicant, staffToken)).status, 401);
      assert.equal(
        (await postSubmit(ownedApplicant, undefined, "legacy-applicant-token"))
          .status,
        401,
      );
    } finally {
      await cleanup(data);
    }
  }),

  test("documents: owner allowed, other customer 404, no token 401, staff token 401", async () => {
    const data = emptyFixture();

    await withUploadLock(async () => {
      try {
        const countryId = await firstCountryId();
        const productId = await createProduct(data, countryId);
        const ownerId = await createCustomer(data, "Documents Owner");
        const otherId = await createCustomer(data, "Documents Other");
        const ownedApplicant = await createApplicant(data, {
          customerId: ownerId,
          productId,
          countryId,
        });
        const foreignApplicant = await createApplicant(data, {
          customerId: otherId,
          productId,
          countryId,
        });

        const ownerToken = await signCustomerToken(ownerId);
        const staffToken = await signStaffToken(ownerId);

        const allowed = await postDocument(ownedApplicant, ownerToken);

        assert.equal(allowed.status, 201);
        assert.equal(allowed.body.documentType, "passport_scan");
        assert.equal(allowed.body.status, "pending_scan");

        const foreign = await postDocument(foreignApplicant, ownerToken);
        const randomApplicant = await postDocument(randomUUID(), ownerToken);

        assert.equal(foreign.status, 404);
        assert.equal(randomApplicant.status, 404);
        assert.deepEqual(foreign.body, randomApplicant.body);

        assert.equal((await postDocument(ownedApplicant)).status, 401);
        assert.equal(
          (await postDocument(ownedApplicant, staffToken)).status,
          401,
        );
        assert.equal(
          (
            await postDocument(
              ownedApplicant,
              undefined,
              "legacy-applicant-token",
            )
          ).status,
          401,
        );
      } finally {
        await cleanup(data);
      }
    });
  }),

  test("anonymous upload: 401, no document row, and no file written", async () => {
    const data = emptyFixture();

    await withUploadLock(async () => {
      try {
        const countryId = await firstCountryId();
        const productId = await createProduct(data, countryId);
        const ownerId = await createCustomer(data, "Anonymous Owner");
        const applicantId = await createApplicant(data, {
          customerId: ownerId,
          productId,
          countryId,
        });

        const filesBefore = await uploadFileCount();
        const response = await postDocument(applicantId);
        const filesAfter = await uploadFileCount();

        assert.equal(response.status, 401);
        assert.equal(filesAfter, filesBefore);

        const rows = await db
          .select({ id: documents.id })
          .from(documents)
          .where(eq(documents.applicantId, applicantId));

        assert.equal(rows.length, 0);
      } finally {
        await cleanup(data);
      }
    });
  }),
];
