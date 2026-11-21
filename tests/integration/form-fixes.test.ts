import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  applicants,
  auditLogs,
  countries,
  customers,
  formFields,
  orders,
  pendingCheckouts,
  visaProducts,
} from "../../src/db/schema.js";
import { signCustomerToken } from "../../src/modules/customer/token.js";
import { getBaseUrl } from "../helpers/server.js";

const REQUIRED_KEY = "fx_required_text";
const OPTIONAL_KEY = "fx_optional_text";
const TRIGGER_KEY = "fx_trigger";
const CONDITIONAL_KEY = "fx_conditional";
const VERSION_TWO_KEY = "fx_version_two_only";

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
): Promise<{ id: string; email: string }> {
  const email = `test-form-${suffix()}@example.test`;

  const [customer] = await db
    .insert(customers)
    .values({
      email,
      name,
      phone: "+15550100000",
      activatedAt: new Date(),
    })
    .returning({ id: customers.id });

  if (!customer) {
    throw new Error("Could not insert the test customer");
  }

  data.customerIds.push(customer.id);

  return { id: customer.id, email };
}

/**
 * Version 1 has a conditional field whose visibility is driven by saved
 * answers. Version 2 exists only so a test can prove the applicant route keeps
 * serving the order-pinned version after the product's current version changes.
 */
async function createProduct(
  data: FixtureData,
  countryId: string,
): Promise<string> {
  const [product] = await db
    .insert(visaProducts)
    .values({
      destinationCountryId: countryId,
      name: `TEST-FORM-PRODUCT-${suffix()}`,
      visaType: "single_entry",
      stayDays: 30,
      processingDaysMin: 1,
      processingDaysMax: 2,
      governmentFeeCents: 1000,
      legworkFeeCents: 500,
      currency: "USD",
      requiredDocuments: [],
      currentFormVersion: 1,
      active: true,
    })
    .returning({ id: visaProducts.id });

  if (!product) {
    throw new Error("Could not insert the test visa product");
  }

  data.productIds.push(product.id);

  await db.insert(formFields).values([
    {
      visaProductId: product.id,
      formVersion: 1,
      step: "full",
      groupKey: "personal",
      fieldKey: REQUIRED_KEY,
      label: "Test required text",
      fieldType: "text",
      required: true,
      options: [],
      sortOrder: 1,
      visibleIf: null,
    },
    {
      visaProductId: product.id,
      formVersion: 1,
      step: "full",
      groupKey: "personal",
      fieldKey: OPTIONAL_KEY,
      label: "Test optional text",
      fieldType: "text",
      required: false,
      options: [],
      sortOrder: 2,
      visibleIf: null,
    },
    {
      visaProductId: product.id,
      formVersion: 1,
      step: "full",
      groupKey: "personal",
      fieldKey: TRIGGER_KEY,
      label: "Test trigger",
      fieldType: "radio",
      required: false,
      options: ["yes", "no"],
      sortOrder: 3,
      visibleIf: null,
    },
    {
      visaProductId: product.id,
      formVersion: 1,
      step: "full",
      groupKey: "personal",
      fieldKey: CONDITIONAL_KEY,
      label: "Test conditional text",
      fieldType: "text",
      required: false,
      options: [],
      sortOrder: 4,
      visibleIf: { field: TRIGGER_KEY, equals: "yes" },
    },
    {
      visaProductId: product.id,
      formVersion: 2,
      step: "full",
      groupKey: "personal",
      fieldKey: VERSION_TWO_KEY,
      label: "Test version two only",
      fieldType: "text",
      required: false,
      options: [],
      sortOrder: 1,
      visibleIf: null,
    },
  ]);

  return product.id;
}

async function createOrder(
  data: FixtureData,
  input: {
    customerId: string;
    productId: string;
    countryId: string;
    answers: Record<string, unknown>;
  },
): Promise<{ orderId: string; applicantId: string }> {
  const token = suffix();
  const contactEmail = `test-form-${token}@example.test`;

  const [checkout] = await db
    .insert(pendingCheckouts)
    .values({
      reference: `TEST-FORM-CHECKOUT-${token}`,
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
      contactEmail,
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
      orderNumber: `TEST-FORM-ORDER-${token}`,
      pendingCheckoutId: checkout.id,
      customerId: input.customerId,
      visaProductId: input.productId,
      passportCountryId: input.countryId,
      travelDate: "2027-06-01",
      travellerCount: 1,
      contactEmail,
      contactPhone: "+15550100000",
      // Pinned separately from the product's current_form_version on purpose.
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
      answers: input.answers,
      status: "incomplete",
    })
    .returning({ id: applicants.id });

  if (!applicant) {
    throw new Error("Could not insert the test applicant");
  }

  data.applicantIds.push(applicant.id);

  return { orderId: order.id, applicantId: applicant.id };
}

async function cleanup(data: FixtureData): Promise<void> {
  if (data.applicantIds.length > 0) {
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.entityId, data.applicantIds));
    await db.delete(applicants).where(inArray(applicants.id, data.applicantIds));
  }

  if (data.orderIds.length > 0) {
    await db.delete(orders).where(inArray(orders.id, data.orderIds));
  }

  if (data.checkoutIds.length > 0) {
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
  body: unknown;
  raw: string;
}

async function readJson(response: Response): Promise<JsonResponse> {
  const raw = await response.text();

  return {
    status: response.status,
    body: raw ? (JSON.parse(raw) as unknown) : null,
    raw,
  };
}

async function getPath(
  path: string,
  token?: string,
): Promise<JsonResponse> {
  const response = await fetch(`${getBaseUrl()}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  return readJson(response);
}

async function getForm(
  applicantId: string,
  token?: string,
  query = "",
): Promise<JsonResponse> {
  const response = await fetch(
    `${getBaseUrl()}/api/v1/applicants/${applicantId}/form${query}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} },
  );

  return readJson(response);
}

async function putAnswers(
  applicantId: string,
  token: string,
  answers: Record<string, unknown>,
): Promise<JsonResponse> {
  const response = await fetch(
    `${getBaseUrl()}/api/v1/applicants/${applicantId}/answers`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ answers }),
    },
  );

  return readJson(response);
}

async function postSubmit(
  applicantId: string,
  token: string,
): Promise<JsonResponse> {
  const response = await fetch(
    `${getBaseUrl()}/api/v1/applicants/${applicantId}/submit`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    },
  );

  return readJson(response);
}

interface FormGroup {
  groupKey: string;
  fields: Array<Record<string, unknown>>;
}

function groupsOf(body: unknown): FormGroup[] {
  return body as FormGroup[];
}

function fieldsOf(body: unknown): Array<Record<string, unknown>> {
  return groupsOf(body).flatMap((group) => group.fields);
}

function fieldKeys(body: unknown): string[] {
  return fieldsOf(body).map((field) => field.fieldKey as string);
}

function fieldByKey(
  body: unknown,
  fieldKey: string,
): Record<string, unknown> | undefined {
  return fieldsOf(body).find((field) => field.fieldKey === fieldKey);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export const suiteTests: Array<Promise<void>> = [
  test("applicant form keeps the order-pinned version after the product's current version is bumped, then restores it", async () => {
    const data = emptyFixture();

    try {
      const countryId = await firstCountryId();
      const productId = await createProduct(data, countryId);
      const customer = await createCustomer(data, "Pinned Customer");
      const token = await signCustomerToken(customer.id);
      const order = await createOrder(data, {
        customerId: customer.id,
        productId,
        countryId,
        answers: {},
      });

      const before = await getForm(order.applicantId, token);

      assert.equal(before.status, 200);
      assert.deepEqual(fieldKeys(before.body).sort(), [
        OPTIONAL_KEY,
        REQUIRED_KEY,
        TRIGGER_KEY,
      ]);
      assert.equal(fieldKeys(before.body).includes(VERSION_TWO_KEY), false);

      // The public product route is unchanged: current version, grouped array,
      // and ?answers= still drives conditional visibility.
      const productBefore = await getPath(
        `/api/v1/visaProducts/${productId}/form`,
      );

      assert.equal(productBefore.status, 200);
      assert.ok(Array.isArray(productBefore.body));
      assert.deepEqual(fieldKeys(productBefore.body).sort(), [
        OPTIONAL_KEY,
        REQUIRED_KEY,
        TRIGGER_KEY,
      ]);

      const productWithAnswers = await getPath(
        `/api/v1/visaProducts/${productId}/form?answers=${encodeURIComponent(
          JSON.stringify({ [TRIGGER_KEY]: "yes" }),
        )}`,
      );

      assert.equal(productWithAnswers.status, 200);
      assert.equal(
        fieldKeys(productWithAnswers.body).includes(CONDITIONAL_KEY),
        true,
      );

      await db
        .update(visaProducts)
        .set({ currentFormVersion: 2 })
        .where(eq(visaProducts.id, productId));

      try {
        const after = await getForm(order.applicantId, token);

        assert.equal(after.status, 200);
        assert.deepEqual(fieldKeys(after.body).sort(), [
          OPTIONAL_KEY,
          REQUIRED_KEY,
          TRIGGER_KEY,
        ]);
        assert.equal(fieldKeys(after.body).includes(VERSION_TWO_KEY), false);

        // The product route still follows current_form_version.
        const productAfter = await getPath(
          `/api/v1/visaProducts/${productId}/form`,
        );

        assert.equal(productAfter.status, 200);
        assert.ok(Array.isArray(productAfter.body));
        assert.deepEqual(fieldKeys(productAfter.body), [VERSION_TWO_KEY]);
      } finally {
        await db
          .update(visaProducts)
          .set({ currentFormVersion: 1 })
          .where(eq(visaProducts.id, productId));
      }
    } finally {
      await cleanup(data);
    }
  }),

  test("every returned field includes visibleIf exactly as stored", async () => {
    const data = emptyFixture();

    try {
      const countryId = await firstCountryId();
      const productId = await createProduct(data, countryId);
      const customer = await createCustomer(data, "VisibleIf Customer");
      const token = await signCustomerToken(customer.id);
      const order = await createOrder(data, {
        customerId: customer.id,
        productId,
        countryId,
        answers: { [TRIGGER_KEY]: "yes" },
      });

      const response = await getForm(order.applicantId, token);

      assert.equal(response.status, 200);

      const fields = fieldsOf(response.body);

      assert.ok(fields.length > 0);

      for (const field of fields) {
        assert.equal(
          hasOwn(field, "visibleIf"),
          true,
          `${field.fieldKey} is missing visibleIf`,
        );
      }

      const conditional = fieldByKey(response.body, CONDITIONAL_KEY);

      assert.ok(conditional);
      assert.deepEqual(conditional.visibleIf, {
        field: TRIGGER_KEY,
        equals: "yes",
      });
      assert.equal(fieldByKey(response.body, REQUIRED_KEY)?.visibleIf, null);
    } finally {
      await cleanup(data);
    }
  }),

  test("?answers= no longer changes the applicant form response", async () => {
    const data = emptyFixture();

    try {
      const countryId = await firstCountryId();
      const productId = await createProduct(data, countryId);
      const customer = await createCustomer(data, "No Query Customer");
      const token = await signCustomerToken(customer.id);
      const order = await createOrder(data, {
        customerId: customer.id,
        productId,
        countryId,
        answers: { [TRIGGER_KEY]: "no" },
      });

      const plain = await getForm(order.applicantId, token);

      assert.equal(plain.status, 200);
      assert.equal(fieldKeys(plain.body).includes(CONDITIONAL_KEY), false);

      const query = `?answers=${encodeURIComponent(
        JSON.stringify({ [TRIGGER_KEY]: "yes" }),
      )}`;
      const withQuery = await getForm(order.applicantId, token, query);

      assert.equal(withQuery.status, 200);
      assert.deepEqual(withQuery.body, plain.body);
      assert.equal(fieldKeys(withQuery.body).includes(CONDITIONAL_KEY), false);
    } finally {
      await cleanup(data);
    }
  }),

  test("null clears an optional answer, and null on a required field fails submit as missing", async () => {
    const data = emptyFixture();

    try {
      const countryId = await firstCountryId();
      const productId = await createProduct(data, countryId);
      const customer = await createCustomer(data, "Clear Customer");
      const token = await signCustomerToken(customer.id);
      const order = await createOrder(data, {
        customerId: customer.id,
        productId,
        countryId,
        answers: {},
      });

      const saved = await putAnswers(order.applicantId, token, {
        [OPTIONAL_KEY]: "temporary",
        [REQUIRED_KEY]: "hello",
      });

      assert.equal(saved.status, 200);

      const cleared = await putAnswers(order.applicantId, token, {
        [OPTIONAL_KEY]: null,
      });

      assert.equal(cleared.status, 200);
      assert.deepEqual(
        (cleared.body as { savedFields: string[] }).savedFields,
        [OPTIONAL_KEY],
      );

      const [afterClear] = await db
        .select({ answers: applicants.answers })
        .from(applicants)
        .where(eq(applicants.id, order.applicantId))
        .limit(1);
      const clearedAnswers = afterClear?.answers as Record<string, unknown>;

      assert.equal(hasOwn(clearedAnswers, OPTIONAL_KEY), false);
      assert.equal(clearedAnswers[REQUIRED_KEY], "hello");

      const clearedRequired = await putAnswers(order.applicantId, token, {
        [REQUIRED_KEY]: null,
      });

      assert.equal(clearedRequired.status, 200);

      const submitted = await postSubmit(order.applicantId, token);

      assert.equal(submitted.status, 400);

      const body = submitted.body as {
        error: string;
        errors: Record<string, string>;
      };

      assert.match(body.error, /Missing required answers/);
      assert.match(body.error, new RegExp(REQUIRED_KEY));
      assert.equal(typeof body.errors[REQUIRED_KEY], "string");
      assert.equal(hasOwn(body.errors, REQUIRED_KEY), true);
    } finally {
      await cleanup(data);
    }
  }),

  test("save validation failures return an errors map keyed by field key", async () => {
    const data = emptyFixture();

    try {
      const countryId = await firstCountryId();
      const productId = await createProduct(data, countryId);
      const customer = await createCustomer(data, "Error Map Customer");
      const token = await signCustomerToken(customer.id);
      const order = await createOrder(data, {
        customerId: customer.id,
        productId,
        countryId,
        answers: {},
      });

      const unknown = await putAnswers(order.applicantId, token, {
        not_a_field: "x",
      });

      assert.equal(unknown.status, 400);
      assert.deepEqual((unknown.body as { errors: unknown }).errors, {
        not_a_field: "Unknown field: not_a_field",
      });
      assert.equal(
        (unknown.body as { error: string }).error,
        "Unknown field: not_a_field",
      );

      const invalid = await putAnswers(order.applicantId, token, {
        [REQUIRED_KEY]: 42,
      });

      assert.equal(invalid.status, 400);
      assert.deepEqual((invalid.body as { errors: unknown }).errors, {
        [REQUIRED_KEY]: `Invalid value for field: ${REQUIRED_KEY}`,
      });

      // The trigger answer is absent, so the conditional field is hidden.
      const hidden = await putAnswers(order.applicantId, token, {
        [CONDITIONAL_KEY]: "x",
      });

      assert.equal(hidden.status, 400);
      assert.deepEqual((hidden.body as { errors: unknown }).errors, {
        [CONDITIONAL_KEY]: `Field not visible: ${CONDITIONAL_KEY}`,
      });
    } finally {
      await cleanup(data);
    }
  }),

  test("applicant form: no token returns 401", async () => {
    const data = emptyFixture();

    try {
      const countryId = await firstCountryId();
      const productId = await createProduct(data, countryId);
      const customer = await createCustomer(data, "Form Auth Customer");
      const order = await createOrder(data, {
        customerId: customer.id,
        productId,
        countryId,
        answers: {},
      });

      const response = await getForm(order.applicantId);

      assert.equal(response.status, 401);
      assert.deepEqual(response.body, {
        error: "Authentication required",
        code: "http_error",
      });
    } finally {
      await cleanup(data);
    }
  }),

  test("applicant form: another customer's token gets the same 404 as an unknown applicant", async () => {
    const data = emptyFixture();

    try {
      const countryId = await firstCountryId();
      const productId = await createProduct(data, countryId);
      const owner = await createCustomer(data, "Form Owner");
      const other = await createCustomer(data, "Form Other");
      const ownerToken = await signCustomerToken(owner.id);
      const foreign = await createOrder(data, {
        customerId: other.id,
        productId,
        countryId,
        answers: {},
      });

      const foreignResponse = await getForm(foreign.applicantId, ownerToken);
      const unknownResponse = await getForm(randomUUID(), ownerToken);

      assert.equal(foreignResponse.status, 404);
      assert.equal(unknownResponse.status, 404);
      assert.deepEqual(foreignResponse.body, unknownResponse.body);
      assert.deepEqual(foreignResponse.body, {
        error: "Applicant not found",
        code: "http_error",
      });

      // A non-field 404 from the shared error handler must not gain `errors`.
      const unknownRoute = await getPath("/api/v1/nothing-here");

      assert.equal(unknownRoute.status, 404);
      assert.deepEqual(unknownRoute.body, {
        error: "Not found",
        code: "not_found",
      });
    } finally {
      await cleanup(data);
    }
  }),
];
