import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { countries, pendingCheckouts, visaProducts } from "../../src/db/schema.js";
import { getBaseUrl } from "../helpers/server.js";

const INDIA_PRODUCT_NAME = "India e-Tourist Visa (DEV PLACEHOLDER)";
const SUPPORTED_DOCUMENT_TYPES = [
  "applicant_photo",
  "passport_scan",
  "return_ticket",
];

interface FormField {
  fieldKey: string;
  fieldType: string;
  options: string[];
  required: boolean;
  label: string;
}

interface FormGroup {
  fields: FormField[];
}

export const suiteTests: Array<Promise<void>> = [
  test("development India product is listed, has its form, and accepts an IN to IN request", async () => {
    const [india] = await db
      .select({ id: countries.id })
      .from(countries)
      .where(eq(countries.iso2, "IN"))
      .limit(1);

    assert.ok(india, "India country row must already exist");

    const [product] = await db
      .select({
        id: visaProducts.id,
        name: visaProducts.name,
        active: visaProducts.active,
        stayDays: visaProducts.stayDays,
        requiredDocuments: visaProducts.requiredDocuments,
      })
      .from(visaProducts)
      .where(eq(visaProducts.destinationCountryId, india.id))
      .limit(1);

    assert.ok(product, "India destination product must exist");
    assert.equal(product.name, INDIA_PRODUCT_NAME);
    assert.equal(product.active, true);
    assert.equal(product.stayDays, 30);
    assert.deepEqual(
      [...product.requiredDocuments].sort(),
      [...SUPPORTED_DOCUMENT_TYPES].sort(),
    );

    const listedResponse = await fetch(
      `${getBaseUrl()}/api/v1/products/IN`,
    );
    assert.equal(listedResponse.status, 200);
    const listedProducts: Array<{ id: string; name: string }> =
      await listedResponse.json();
    assert.ok(
      listedProducts.some(
        (listed) => listed.id === product.id && listed.name === INDIA_PRODUCT_NAME,
      ),
    );

    const formResponse = await fetch(
      `${getBaseUrl()}/api/v1/visaProducts/${product.id}/form`,
    );
    assert.equal(formResponse.status, 200);
    const formGroups: unknown = await formResponse.json();
    assert.ok(Array.isArray(formGroups) && formGroups.length > 0);
    const fields = (formGroups as FormGroup[]).flatMap((group) => group.fields);
    const eligibilityField = fields.find(
      (field) => field.fieldKey === "has_pakistani_origin_or_parent",
    );

    assert.ok(eligibilityField);
    assert.equal(eligibilityField.fieldType, "radio");
    assert.deepEqual(eligibilityField.options, ["yes", "no"]);
    assert.equal(eligibilityField.required, true);
    assert.equal(
      eligibilityField.label,
      "Are you of Pakistani origin or passport, or were your parents or grandparents born in, or permanently resident in, Pakistan?",
    );

    let checkoutId: string | undefined;

    try {
      const travelDate = new Date(
        Date.now() + 90 * 24 * 60 * 60 * 1000,
      )
        .toISOString()
        .slice(0, 10);
      const response = await fetch(`${getBaseUrl()}/api/v1/requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          destinationIso2: "IN",
          passportIso2: "IN",
          visaProductId: product.id,
          travelDate,
          contactEmail: `test-india-request-${randomUUID().slice(0, 12)}@example.test`,
          applicants: [
            {
              fullName: "Test Applicant",
              gender: "female",
              maritalStatus: "single",
            },
          ],
        }),
      });
      const responseBody: unknown = await response.json();

      assert.equal(response.status, 201);
      assert.ok(
        typeof responseBody === "object" &&
          responseBody !== null &&
          "id" in responseBody &&
          typeof responseBody.id === "string",
      );
      checkoutId = responseBody.id;
    } finally {
      if (checkoutId) {
        await db
          .delete(pendingCheckouts)
          .where(eq(pendingCheckouts.id, checkoutId));
      }
    }
  }),
];
