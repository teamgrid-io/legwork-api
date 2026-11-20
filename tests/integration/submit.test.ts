import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  applicants,
  auditLogs,
  countries,
  documents,
  formFields,
  orders,
  pendingCheckouts,
  visaProducts,
} from "../../src/db/schema.js";
import { HttpError } from "../../src/lib/errors.js";
import {
  saveAnswers,
  submitApplication,
} from "../../src/modules/applications/service.js";

interface SubmitFixture {
  productId: string;
  checkoutId: string;
  orderId: string;
  applicantId: string;
  suffix: string;
}

const TEST_FIELD_KEY = "test_required_text";
const TEST_DOCUMENT_TYPE = "passport_scan";

async function createFixture(): Promise<SubmitFixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);

  const [country] = await db
    .select({ id: countries.id })
    .from(countries)
    .limit(1);

  if (!country) {
    throw new Error(
      "legwork_test has no countries row; seed the test database first",
    );
  }

  const [product] = await db
    .insert(visaProducts)
    .values({
      destinationCountryId: country.id,
      name: `TEST-SUB-PRODUCT-${suffix}`,
      visaType: "single_entry",
      stayDays: 30,
      processingDaysMin: 1,
      processingDaysMax: 2,
      governmentFeeCents: 1000,
      legworkFeeCents: 500,
      currency: "USD",
      requiredDocuments: [TEST_DOCUMENT_TYPE],
      currentFormVersion: 1,
      active: true,
    })
    .returning({ id: visaProducts.id });

  if (!product) {
    throw new Error("Could not insert the test visa product");
  }

  await db.insert(formFields).values({
    visaProductId: product.id,
    formVersion: 1,
    step: "full",
    groupKey: "personal",
    fieldKey: TEST_FIELD_KEY,
    label: "Test required text",
    fieldType: "text",
    required: true,
    options: [],
    sortOrder: 1,
    visibleIf: null,
  });

  const [checkout] = await db
    .insert(pendingCheckouts)
    .values({
      reference: `TEST-SUB-${suffix}`,
      visaProductId: product.id,
      passportCountryId: country.id,
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
      contactEmail: `submit-${suffix}@example.test`,
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

  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `TEST-ORDER-${suffix}`,
      pendingCheckoutId: checkout.id,
      visaProductId: product.id,
      passportCountryId: country.id,
      travelDate: "2027-06-01",
      travellerCount: 1,
      contactEmail: `submit-${suffix}@example.test`,
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

  const [applicant] = await db
    .insert(applicants)
    .values({
      orderId: order.id,
      sortOrder: 1,
      firstName: "Test",
      surname: "Traveller",
      answers: { [TEST_FIELD_KEY]: "hello" },
      status: "incomplete",
    })
    .returning({ id: applicants.id });

  if (!applicant) {
    throw new Error("Could not insert the test applicant");
  }

  return {
    productId: product.id,
    checkoutId: checkout.id,
    orderId: order.id,
    applicantId: applicant.id,
    suffix,
  };
}

async function addVerifiedPassport(fixture: SubmitFixture): Promise<void> {
  await db.insert(documents).values({
    applicantId: fixture.applicantId,
    documentType: TEST_DOCUMENT_TYPE,
    storageKey: `TEST-DOC-${fixture.suffix}`,
    sha256: "a".repeat(64),
    mimeType: "image/jpeg",
    sizeBytes: 4,
    status: "verified",
    uploadedAt: new Date(),
  });
}

async function countDocuments(applicantId: string): Promise<number> {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.applicantId, applicantId));

  return rows.length;
}

/**
 * Remove only this fixture's rows, in FK order. The shared cleanTestFixtures()
 * also removes the TEST- checkout/order, but this keeps each test isolated.
 */
async function cleanup(fixture: SubmitFixture): Promise<void> {
  const documentRows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.applicantId, fixture.applicantId));

  const documentIds = documentRows.map((row) => row.id);

  if (documentIds.length > 0) {
    await db
      .delete(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "document"),
          inArray(auditLogs.entityId, documentIds),
        ),
      );
  }

  await db
    .delete(auditLogs)
    .where(
      and(
        eq(auditLogs.entityType, "applicant"),
        eq(auditLogs.entityId, fixture.applicantId),
      ),
    );

  await db.delete(documents).where(eq(documents.applicantId, fixture.applicantId));
  await db.delete(applicants).where(eq(applicants.id, fixture.applicantId));
  await db.delete(orders).where(eq(orders.id, fixture.orderId));
  await db
    .delete(pendingCheckouts)
    .where(eq(pendingCheckouts.id, fixture.checkoutId));

  await db
    .delete(formFields)
    .where(
      and(
        eq(formFields.visaProductId, fixture.productId),
        eq(formFields.formVersion, 1),
      ),
    );

  await db.delete(visaProducts).where(eq(visaProducts.id, fixture.productId));
}

export const suiteTests: Array<Promise<void>> = [
  test("submit with a missing required document returns 400 and leaves stored answers unchanged", async () => {
    const fixture = await createFixture();

    try {
      await assert.rejects(
        () => submitApplication(fixture.applicantId),
        (error: unknown) =>
          error instanceof HttpError &&
          error.statusCode === 400 &&
          error.message === `Missing required documents: ${TEST_DOCUMENT_TYPE}`,
      );

      const [row] = await db
        .select({ answers: applicants.answers })
        .from(applicants)
        .where(eq(applicants.id, fixture.applicantId))
        .limit(1);

      assert.deepEqual(row?.answers, { [TEST_FIELD_KEY]: "hello" });
    } finally {
      await cleanup(fixture);
    }
  }),

  test("two concurrent submits for the same applicant: exactly one 200, one 409, answers written once", async () => {
    const fixture = await createFixture();

    try {
      await addVerifiedPassport(fixture);

      const results = await Promise.allSettled([
        submitApplication(fixture.applicantId),
        submitApplication(fixture.applicantId),
      ]);

      const fulfilled = results.find((result) => result.status === "fulfilled");
      const rejected = results.find((result) => result.status === "rejected");

      assert.ok(fulfilled && fulfilled.status === "fulfilled");
      assert.ok(rejected && rejected.status === "rejected");
      assert.equal(fulfilled.value.status, "complete");

      const error: unknown = rejected.reason;

      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);

      const [row] = await db
        .select({ answers: applicants.answers, status: applicants.status })
        .from(applicants)
        .where(eq(applicants.id, fixture.applicantId))
        .limit(1);

      assert.equal(row?.status, "complete");
      assert.deepEqual(row?.answers, { [TEST_FIELD_KEY]: "hello" });

      const submitAuditRows = await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, "applicant"),
            eq(auditLogs.entityId, fixture.applicantId),
            eq(auditLogs.action, "applicant.submitted"),
          ),
        );

      assert.equal(submitAuditRows.length, 1);
    } finally {
      await cleanup(fixture);
    }
  }),

  test("save answers after submit returns 409 and does not change answers", async () => {
    const fixture = await createFixture();

    try {
      await addVerifiedPassport(fixture);
      await submitApplication(fixture.applicantId);

      await assert.rejects(
        () => saveAnswers(fixture.applicantId, { [TEST_FIELD_KEY]: "changed" }),
        (error: unknown) =>
          error instanceof HttpError && error.statusCode === 409,
      );

      const [row] = await db
        .select({ answers: applicants.answers })
        .from(applicants)
        .where(eq(applicants.id, fixture.applicantId))
        .limit(1);

      assert.deepEqual(row?.answers, { [TEST_FIELD_KEY]: "hello" });
    } finally {
      await cleanup(fixture);
    }
  }),

  test("upload after submit is rejected and inserts no document row", async () => {
    const fixture = await createFixture();

    try {
      await addVerifiedPassport(fixture);
      await submitApplication(fixture.applicantId);

      const before = await countDocuments(fixture.applicantId);

      const { uploadDocument } = await import(
        "../../src/modules/documents/service.js"
      );

      try {
        await assert.rejects(
          () =>
            uploadDocument({
              applicantId: fixture.applicantId,
              documentType: TEST_DOCUMENT_TYPE,
              buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
              declaredMime: "image/jpeg",
            }),
          (error: unknown) =>
            error instanceof HttpError && error.statusCode === 409,
        );
      } finally {
        // Importing the documents service also opens the BullMQ producer
        // connection; close it so the test process can exit.
        const { documentScanQueue } = await import("../../src/lib/queue.js");
        await documentScanQueue.close();
      }

      const after = await countDocuments(fixture.applicantId);

      assert.equal(after, before);
    } finally {
      await cleanup(fixture);
    }
  }),
];
