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
  documents,
  formFields,
  orderEvents,
  orders,
  payments,
  pendingCheckouts,
  visaProducts,
} from "../../src/db/schema.js";
import { encryptField } from "../../src/lib/crypto.js";
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
): Promise<{ id: string; email: string }> {
  const email = `test-read-${suffix()}@example.test`;

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

async function createProduct(
  data: FixtureData,
  countryId: string,
  requiredDocuments: string[],
): Promise<string> {
  const [product] = await db
    .insert(visaProducts)
    .values({
      destinationCountryId: countryId,
      name: `TEST-READ-PRODUCT-${suffix()}`,
      visaType: "single_entry",
      stayDays: 30,
      processingDaysMin: 1,
      processingDaysMax: 2,
      governmentFeeCents: 1000,
      legworkFeeCents: 500,
      currency: "USD",
      requiredDocuments,
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
      fieldKey: "test_required_text",
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
      groupKey: "declaration",
      fieldKey: "test_required_checkbox",
      label: "Test required checkbox",
      fieldType: "checkbox",
      required: true,
      options: [],
      sortOrder: 2,
      visibleIf: null,
    },
    {
      visaProductId: product.id,
      formVersion: 1,
      step: "full",
      groupKey: "personal",
      fieldKey: "test_optional_text",
      label: "Test optional text",
      fieldType: "text",
      required: false,
      options: [],
      sortOrder: 3,
      visibleIf: null,
    },
  ]);

  return product.id;
}

interface CheckoutFixture {
  id: string;
  sessionId: string;
  contactEmail: string;
}

async function createCheckout(
  data: FixtureData,
  productId: string,
  countryId: string,
): Promise<CheckoutFixture> {
  const token = suffix();
  const contactEmail = `test-read-${token}@example.test`;

  const [checkout] = await db
    .insert(pendingCheckouts)
    .values({
      reference: `TEST-READ-CHECKOUT-${token}`,
      visaProductId: productId,
      passportCountryId: countryId,
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
      stripeSessionId: `TEST-cs-read-${token}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning({
      id: pendingCheckouts.id,
      stripeSessionId: pendingCheckouts.stripeSessionId,
    });

  if (!checkout || !checkout.stripeSessionId) {
    throw new Error("Could not insert the test pending checkout");
  }

  data.checkoutIds.push(checkout.id);

  return {
    id: checkout.id,
    sessionId: checkout.stripeSessionId,
    contactEmail,
  };
}

interface OrderFixture {
  orderId: string;
  orderNumber: string;
  applicantId: string;
  checkout: CheckoutFixture;
}

async function createOrder(
  data: FixtureData,
  input: {
    customerId: string;
    productId: string;
    countryId: string;
    answers: Record<string, unknown>;
    createdAt?: Date;
    checkout?: CheckoutFixture;
  },
): Promise<OrderFixture> {
  const checkout =
    input.checkout ??
    (await createCheckout(data, input.productId, input.countryId));
  const token = suffix();
  const createdAt = input.createdAt ?? new Date();

  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `TEST-READ-ORDER-${token}`,
      pendingCheckoutId: checkout.id,
      customerId: input.customerId,
      visaProductId: input.productId,
      passportCountryId: input.countryId,
      travelDate: "2027-06-01",
      travellerCount: 1,
      contactEmail: checkout.contactEmail,
      contactPhone: "+15550100000",
      formVersion: 1,
      amountCents: 1500,
      currency: "USD",
      status: "paid",
      paidAt: createdAt,
      createdAt,
    })
    .returning({ id: orders.id, orderNumber: orders.orderNumber });

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

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    applicantId: applicant.id,
    checkout,
  };
}

async function cleanup(data: FixtureData): Promise<void> {
  if (data.applicantIds.length > 0) {
    await db
      .delete(documents)
      .where(inArray(documents.applicantId, data.applicantIds));
    await db
      .delete(auditLogs)
      .where(
        inArray(auditLogs.entityId, data.applicantIds),
      );
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
  raw: string;
}

async function getJson(path: string, token?: string): Promise<JsonResponse> {
  const response = await fetch(`${getBaseUrl()}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const raw = await response.text();

  return {
    status: response.status,
    body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    raw,
  };
}

function ordersOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return body.orders as Array<Record<string, unknown>>;
}

export const suiteTests: Array<Promise<void>> = [
  test("customer A sees only their own orders; customer B's order number returns 404 for A", async () => {
    const data = emptyFixture();

    try {
      const countryId = await firstCountryId();
      const productId = await createProduct(data, countryId, []);
      const customerA = await createCustomer(data, "Customer A");
      const customerB = await createCustomer(data, "Customer B");
      const orderA = await createOrder(data, {
        customerId: customerA.id,
        productId,
        countryId,
        answers: {},
      });
      const orderB = await createOrder(data, {
        customerId: customerB.id,
        productId,
        countryId,
        answers: {},
      });

      const tokenA = await signCustomerToken(customerA.id);

      const list = await getJson("/api/v1/auth/orders", tokenA);

      assert.equal(list.status, 200);
      assert.equal(ordersOf(list.body).length, 1);
      assert.equal(ordersOf(list.body)[0]?.orderNumber, orderA.orderNumber);
      assert.equal(ordersOf(list.body)[0]?.applicantCount, 1);

      const foreign = await getJson(
        `/api/v1/auth/orders/${orderB.orderNumber}`,
        tokenA,
      );

      assert.equal(foreign.status, 404);

      const own = await getJson(
        `/api/v1/auth/orders/${orderA.orderNumber}`,
        tokenA,
      );

      assert.equal(own.status, 200);
      assert.equal(own.body.orderNumber, orderA.orderNumber);
    } finally {
      await cleanup(data);
    }
  }),

  test("list is paginated and newest first", async () => {
    const data = emptyFixture();

    try {
      const countryId = await firstCountryId();
      const productId = await createProduct(data, countryId, []);
      const customer = await createCustomer(data, "Paged Customer");
      const token = await signCustomerToken(customer.id);

      const oldest = await createOrder(data, {
        customerId: customer.id,
        productId,
        countryId,
        answers: {},
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      });
      const middle = await createOrder(data, {
        customerId: customer.id,
        productId,
        countryId,
        answers: {},
        createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      });
      const newest = await createOrder(data, {
        customerId: customer.id,
        productId,
        countryId,
        answers: {},
        createdAt: new Date(),
      });

      const firstPage = await getJson(
        "/api/v1/auth/orders?limit=2&offset=0",
        token,
      );

      assert.equal(firstPage.status, 200);
      assert.deepEqual(
        ordersOf(firstPage.body).map((order) => order.orderNumber),
        [newest.orderNumber, middle.orderNumber],
      );

      const secondPage = await getJson(
        "/api/v1/auth/orders?limit=2&offset=2",
        token,
      );

      assert.equal(secondPage.status, 200);
      assert.deepEqual(
        ordersOf(secondPage.body).map((order) => order.orderNumber),
        [oldest.orderNumber],
      );

      const defaultPage = await getJson("/api/v1/auth/orders", token);

      assert.equal(defaultPage.status, 200);
      assert.equal(ordersOf(defaultPage.body).length, 3);
    } finally {
      await cleanup(data);
    }
  }),

  test("detail masks passport_number to its last 3 characters and never returns the full value", async () => {
    const data = emptyFixture();

    try {
      const countryId = await firstCountryId();
      const productId = await createProduct(data, countryId, []);
      const customer = await createCustomer(data, "Masked Customer");
      const token = await signCustomerToken(customer.id);
      const plainPassport = "P1234567";

      const order = await createOrder(data, {
        customerId: customer.id,
        productId,
        countryId,
        answers: {
          test_required_text: "hello",
          test_required_checkbox: true,
          passport_number: encryptField(plainPassport),
          gender: "female",
        },
      });

      const detail = await getJson(
        `/api/v1/auth/orders/${order.orderNumber}`,
        token,
      );

      assert.equal(detail.status, 200);

      const applicant = (detail.body.applicants as Array<
        Record<string, unknown>
      >)[0];

      assert.ok(applicant);

      const answers = applicant.answers as Record<string, unknown>;

      assert.equal(answers.passport_number, "***567");
      assert.equal(JSON.stringify(detail.body).includes(plainPassport), false);
      // Searched over the raw response text, so escaping or an extra field
      // cannot hide a full passport value from this check.
      assert.equal(detail.raw.includes(plainPassport), false);
    } finally {
      await cleanup(data);
    }
  }),

  test("progress counts required answers and required documents per applicant", async () => {
    const data = emptyFixture();

    try {
      const countryId = await firstCountryId();
      const productId = await createProduct(data, countryId, [
        "passport_scan",
        "applicant_photo",
      ]);
      const customer = await createCustomer(data, "Progress Customer");
      const token = await signCustomerToken(customer.id);

      const order = await createOrder(data, {
        customerId: customer.id,
        productId,
        countryId,
        answers: {
          // One of the two required fields is answered; the checkbox is false.
          test_required_text: "hello",
          test_required_checkbox: false,
        },
      });

      await db.insert(documents).values({
        applicantId: order.applicantId,
        documentType: "passport_scan",
        storageKey: `TEST-READ-DOC-${suffix()}`,
        sha256: "a".repeat(64),
        mimeType: "application/pdf",
        sizeBytes: 1024,
        status: "uploaded",
      });

      const detail = await getJson(
        `/api/v1/auth/orders/${order.orderNumber}`,
        token,
      );

      assert.equal(detail.status, 200);

      const applicant = (detail.body.applicants as Array<
        Record<string, unknown>
      >)[0];

      assert.ok(applicant);
      assert.deepEqual(applicant.progress, {
        answers: { answered: 1, total: 2 },
        documents: { uploaded: 1, required: 2 },
      });
    } finally {
      await cleanup(data);
    }
  }),

  test("verify returns orderNumber after the order exists and null before", async () => {
    const data = emptyFixture();

    try {
      const countryId = await firstCountryId();
      const productId = await createProduct(data, countryId, []);
      const customer = await createCustomer(data, "Verify Customer");
      const checkout = await createCheckout(data, productId, countryId);

      const before = await getJson(
        `/api/v1/payments/verify?session_id=${encodeURIComponent(checkout.sessionId)}`,
      );

      assert.equal(before.status, 200);
      assert.equal(before.body.orderNumber, null);
      assert.equal(before.body.paid, true);
      assert.equal(before.body.status, "paid");
      assert.equal(typeof before.body.reference, "string");

      const order = await createOrder(data, {
        customerId: customer.id,
        productId,
        countryId,
        answers: {},
        checkout,
      });

      const after = await getJson(
        `/api/v1/payments/verify?session_id=${encodeURIComponent(checkout.sessionId)}`,
      );

      assert.equal(after.status, 200);
      assert.equal(after.body.orderNumber, order.orderNumber);
      assert.equal(after.body.reference, before.body.reference);
      assert.equal(after.body.paid, true);
      assert.equal(after.body.status, "paid");
    } finally {
      await cleanup(data);
    }
  }),

  test("unauthenticated and staff-token requests are rejected 401", async () => {
    const data = emptyFixture();

    try {
      const countryId = await firstCountryId();
      const productId = await createProduct(data, countryId, []);
      const customer = await createCustomer(data, "Auth Customer");
      const order = await createOrder(data, {
        customerId: customer.id,
        productId,
        countryId,
        answers: {},
      });
      const staffToken = await signStaffToken(customer.id);

      assert.equal((await getJson("/api/v1/auth/orders")).status, 401);
      assert.equal(
        (await getJson("/api/v1/auth/orders", staffToken)).status,
        401,
      );
      assert.equal(
        (await getJson(`/api/v1/auth/orders/${order.orderNumber}`)).status,
        401,
      );
      assert.equal(
        (
          await getJson(
            `/api/v1/auth/orders/${order.orderNumber}`,
            staffToken,
          )
        ).status,
        401,
      );
    } finally {
      await cleanup(data);
    }
  }),
];
