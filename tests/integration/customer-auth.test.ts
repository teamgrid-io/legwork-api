import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { and, eq, inArray, like } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  auditLogs,
  customers,
  orderEvents,
  orders,
  payments,
  pendingCheckouts,
  visaProducts,
} from "../../src/db/schema.js";
import type { MailMessage } from "../../src/lib/mail.js";
import { setMailSender } from "../../src/lib/mail.js";
import { newTestEventId, TEST_SESSION_PREFIX } from "../helpers/db.js";
import { getBaseUrl, postStripeEvent } from "../helpers/server.js";
import {
  buildCheckoutCompletedEvent,
  signStripePayload,
} from "../helpers/stripe-sign.js";

// The staff config validates JWT_SECRET at import time. Set it before the staff
// token module is imported so /me can be probed with a genuine staff token.
process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-32-chars";

// Activation tokens exist only in the mail body. ES module exports are
// immutable, so the suite installs a capturing sender once, shared by all tests;
// each test filters by its own unique recipient address.
const sentMails: MailMessage[] = [];

setMailSender(async (message) => {
  sentMails.push(message);
});

const EMAIL_PREFIX = "test-customer-";
const ACTIVATION_PASSWORD = "customer-password-123";
const CHECKOUT_PHONE = "+15550100000";
const CUSTOMER_TOKEN_TTL_SECONDS = 12 * 60 * 60;

function newEmail(): string {
  return `${EMAIL_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 12)}@example.test`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface ParentIds {
  visaProductId: string;
  countryId: string;
}

let cachedParents: ParentIds | null = null;

async function parentIds(): Promise<ParentIds> {
  if (cachedParents) {
    return cachedParents;
  }

  const [product] = await db
    .select({
      id: visaProducts.id,
      destinationCountryId: visaProducts.destinationCountryId,
    })
    .from(visaProducts)
    .limit(1);

  if (!product) {
    throw new Error(
      "legwork_test has no visa_products row; seed the test database first",
    );
  }

  cachedParents = {
    visaProductId: product.id,
    countryId: product.destinationCountryId,
  };

  return cachedParents;
}

interface CheckoutFixture {
  sessionId: string;
  eventId: string;
}

async function createCheckout(email: string): Promise<CheckoutFixture> {
  const parents = await parentIds();
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);

  const [checkout] = await db
    .insert(pendingCheckouts)
    .values({
      reference: `TEST-CUST-${suffix}`,
      visaProductId: parents.visaProductId,
      passportCountryId: parents.countryId,
      travelDate: "2027-06-01",
      travellerCount: 1,
      travellers: [
        {
          first_name: "Test",
          surname: "Customer",
          gender: "female",
          maritalStatus: "single",
        },
      ],
      contactEmail: email,
      contactPhone: CHECKOUT_PHONE,
      formVersion: 1,
      governmentFeeCents: 8000,
      legworkFeeCents: 2000,
      amountCents: 10000,
      currency: "usd",
      status: "open",
      stripeSessionId: `${TEST_SESSION_PREFIX}cust-${suffix}`,
      expiresAt: new Date(Date.now() + 20 * 60 * 1000),
    })
    .returning({
      id: pendingCheckouts.id,
      stripeSessionId: pendingCheckouts.stripeSessionId,
    });

  if (!checkout || !checkout.stripeSessionId) {
    throw new Error("Could not insert the customer test checkout");
  }

  return {
    sessionId: checkout.stripeSessionId,
    eventId: newTestEventId(),
  };
}

async function deliverPaidCheckout(
  fixture: CheckoutFixture,
  eventId: string = fixture.eventId,
): Promise<Record<string, unknown>> {
  const payload = buildCheckoutCompletedEvent({
    eventId,
    sessionId: fixture.sessionId,
    created: new Date(),
    amountTotal: 10000,
    currency: "usd",
    paymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
  });

  const response = await postStripeEvent(
    payload,
    signStripePayload(payload),
  );

  assert.equal(response.status, 200);

  return response.body;
}

async function findCustomer(email: string) {
  const [row] = await db
    .select()
    .from(customers)
    .where(eq(customers.email, email))
    .limit(1);

  return row ?? null;
}

async function findOrders(email: string) {
  return db
    .select({ id: orders.id, customerId: orders.customerId })
    .from(orders)
    .where(eq(orders.contactEmail, email));
}

function mailsFor(email: string): MailMessage[] {
  return sentMails.filter((mail) => mail.to === email);
}

/** The activation token is the last `token=` value mailed to this address. */
function activationTokenFor(email: string): string {
  const mails = mailsFor(email);
  const mail = mails[mails.length - 1];

  if (!mail) {
    throw new Error("No activation mail was sent for this address");
  }

  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(mail.text);

  if (!match || !match[1]) {
    throw new Error("Activation mail has no token link");
  }

  return match[1];
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function postJson(
  path: string,
  body: unknown,
  token?: string,
): Promise<JsonResponse> {
  const response = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();

  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function getJson(path: string, token?: string): Promise<JsonResponse> {
  const response = await fetch(`${getBaseUrl()}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  const text = await response.text();

  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

/**
 * Delete only this address's rows, in FK order: order events, orders (cascading
 * applicants), payments, checkouts, customer audit rows, then the customer.
 */
async function cleanup(email: string): Promise<void> {
  const customerRows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.email, email));

  const customerIds = customerRows.map((row) => row.id);

  const orderRows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.contactEmail, email));

  const orderIds = orderRows.map((row) => row.id);

  if (orderIds.length > 0) {
    await db
      .delete(orderEvents)
      .where(inArray(orderEvents.orderId, orderIds));
    await db.delete(orders).where(inArray(orders.id, orderIds));
  }

  const checkoutRows = await db
    .select({ id: pendingCheckouts.id })
    .from(pendingCheckouts)
    .where(eq(pendingCheckouts.contactEmail, email));

  const checkoutIds = checkoutRows.map((row) => row.id);

  if (checkoutIds.length > 0) {
    await db
      .delete(payments)
      .where(inArray(payments.pendingCheckoutId, checkoutIds));
    await db
      .delete(pendingCheckouts)
      .where(inArray(pendingCheckouts.id, checkoutIds));
  }

  if (customerIds.length > 0) {
    await db
      .delete(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "customer"),
          inArray(auditLogs.entityId, customerIds),
        ),
      );
    await db.delete(customers).where(inArray(customers.id, customerIds));
  }
}

/** Remove fixture rows that a previous failed run may have left behind. */
async function cleanStaleFixtures(): Promise<void> {
  const stale = await db
    .select({ email: customers.email })
    .from(customers)
    .where(like(customers.email, `${EMAIL_PREFIX}%`));

  for (const row of stale) {
    await cleanup(row.email);
  }
}

const tests: Array<Promise<void>> = [
  test("one customer per email, shared across two orders, orders.customer_id set", async () => {
    const email = newEmail();

    try {
      const first = await createCheckout(email);
      await deliverPaidCheckout(first);

      const second = await createCheckout(email);
      await deliverPaidCheckout(second);

      const customer = await findCustomer(email);

      assert.ok(customer);
      assert.equal(customer.name, "Test Customer");
      assert.equal(customer.phone, CHECKOUT_PHONE);
      assert.equal(customer.activatedAt, null);

      const customerRows = await db
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.email, email));

      assert.equal(customerRows.length, 1);

      const orderRows = await findOrders(email);

      assert.equal(orderRows.length, 2);

      for (const order of orderRows) {
        assert.equal(order.customerId, customer.id);
      }
    } finally {
      await cleanup(email);
    }
  }),

  test("a replayed webhook sends no second activation mail", async () => {
    const email = newEmail();

    try {
      const fixture = await createCheckout(email);
      await deliverPaidCheckout(fixture);

      assert.equal(mailsFor(email).length, 1);

      // Same event id: the claim sees "processed" and never reaches the service.
      await deliverPaidCheckout(fixture);

      // Different event id, same session: the payment is already decided, so
      // the order is reused and no new customer work happens.
      await deliverPaidCheckout(fixture, newTestEventId());

      assert.equal(mailsFor(email).length, 1);
      assert.equal((await findOrders(email)).length, 1);
    } finally {
      await cleanup(email);
    }
  }),

  test("activation works once; a reused, expired, or wrong token fails", async () => {
    const email = newEmail();
    const expiredEmail = newEmail();

    try {
      const fixture = await createCheckout(email);
      await deliverPaidCheckout(fixture);

      const token = activationTokenFor(email);

      const activated = await postJson("/api/v1/auth/activate", {
        token,
        password: ACTIVATION_PASSWORD,
      });

      assert.equal(activated.status, 200);
      assert.equal(
        activated.body.expiresInSeconds,
        CUSTOMER_TOKEN_TTL_SECONDS,
      );

      const customer = await findCustomer(email);

      assert.ok(customer);
      assert.equal((activated.body.customer as { id: string }).id, customer.id);
      assert.equal(
        (activated.body.customer as { email: string }).email,
        email,
      );
      assert.notEqual(customer.activatedAt, null);
      assert.equal(customer.activationTokenHash, null);
      assert.equal(customer.activationExpiresAt, null);
      assert.match(customer.passwordHash ?? "", /^scrypt\$/);

      const reused = await postJson("/api/v1/auth/activate", {
        token,
        password: ACTIVATION_PASSWORD,
      });

      assert.equal(reused.status, 400);
      assert.equal(reused.body.error, "Invalid or expired activation link");

      const wrong = await postJson("/api/v1/auth/activate", {
        token: "not-a-real-activation-token",
        password: ACTIVATION_PASSWORD,
      });

      assert.equal(wrong.status, 400);
      assert.equal(wrong.body.error, "Invalid or expired activation link");

      // Expired link: correct hash, expiry in the past.
      const expiredToken = "expired-token-value";
      await db.insert(customers).values({
        email: expiredEmail,
        name: "Expired Customer",
        activationTokenHash: sha256Hex(expiredToken),
        activationExpiresAt: new Date(Date.now() - 60 * 1000),
      });

      const expired = await postJson("/api/v1/auth/activate", {
        token: expiredToken,
        password: ACTIVATION_PASSWORD,
      });

      assert.equal(expired.status, 400);
      assert.equal(expired.body.error, "Invalid or expired activation link");
      assert.equal((await findCustomer(expiredEmail))?.activatedAt, null);
    } finally {
      await cleanup(email);
      await cleanup(expiredEmail);
    }
  }),

  test("login fails before activation with the same 401 as a wrong password, then works", async () => {
    const email = newEmail();

    try {
      const fixture = await createCheckout(email);
      await deliverPaidCheckout(fixture);

      const beforeActivation = await postJson("/api/v1/auth/login", {
        email,
        password: ACTIVATION_PASSWORD,
      });

      const unknown = await postJson("/api/v1/auth/login", {
        email: newEmail(),
        password: ACTIVATION_PASSWORD,
      });

      assert.equal(beforeActivation.status, 401);
      assert.equal(unknown.status, 401);
      assert.deepEqual(beforeActivation.body, unknown.body);

      const token = activationTokenFor(email);
      const activated = await postJson("/api/v1/auth/activate", {
        token,
        password: ACTIVATION_PASSWORD,
      });

      assert.equal(activated.status, 200);

      const wrongPassword = await postJson("/api/v1/auth/login", {
        email,
        password: "definitely-not-the-password",
      });

      assert.equal(wrongPassword.status, 401);
      assert.deepEqual(wrongPassword.body, unknown.body);

      const loggedIn = await postJson("/api/v1/auth/login", {
        email,
        password: ACTIVATION_PASSWORD,
      });

      assert.equal(loggedIn.status, 200);
      assert.equal(
        (loggedIn.body.customer as { email: string }).email,
        email,
      );

      const me = await getJson(
        "/api/v1/auth/me",
        loggedIn.body.token as string,
      );

      assert.equal(me.status, 200);
      assert.equal(me.body.email, email);
    } finally {
      await cleanup(email);
    }
  }),

  test("GET /me accepts a customer token and rejects staff, missing, expired, and tampered tokens", async () => {
    const email = newEmail();

    try {
      const fixture = await createCheckout(email);
      await deliverPaidCheckout(fixture);

      const token = activationTokenFor(email);
      const activated = await postJson("/api/v1/auth/activate", {
        token,
        password: ACTIVATION_PASSWORD,
      });

      assert.equal(activated.status, 200);

      const customerToken = activated.body.token as string;
      const me = await getJson("/api/v1/auth/me", customerToken);

      assert.equal(me.status, 200);
      assert.deepEqual(Object.keys(me.body).sort(), [
        "email",
        "id",
        "name",
        "phone",
      ]);
      assert.equal(me.body.email, email);
      assert.equal(me.body.name, "Test Customer");
      assert.equal(me.body.phone, CHECKOUT_PHONE);

      const customer = await findCustomer(email);
      assert.ok(customer);

      const { signStaffToken } = await import(
        "../../src/modules/staff/token.js"
      );
      const staffToken = await signStaffToken(customer.id);

      assert.equal((await getJson("/api/v1/auth/me", staffToken)).status, 401);
      assert.equal((await getJson("/api/v1/auth/me")).status, 401);

      const { SignJWT } = await import("jose");
      const customerSecret = process.env.CUSTOMER_JWT_SECRET;

      assert.ok(customerSecret);

      const nowSeconds = Math.floor(Date.now() / 1000);

      const expired = await new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(customer.id)
        .setIssuedAt(nowSeconds - 7200)
        .setIssuer("legwork-api")
        .setAudience("legwork-customer")
        .setExpirationTime(nowSeconds - 3600)
        .sign(new TextEncoder().encode(customerSecret));

      assert.equal((await getJson("/api/v1/auth/me", expired)).status, 401);

      const tampered = `${customerToken.slice(0, -2)}${
        customerToken.endsWith("aa") ? "bb" : "aa"
      }`;

      assert.equal((await getJson("/api/v1/auth/me", tampered)).status, 401);
    } finally {
      await cleanup(email);
    }
  }),

  test("resend returns the same response for known and unknown emails", async () => {
    const email = newEmail();
    const activatedEmail = newEmail();
    const unknownEmail = newEmail();

    try {
      const fixture = await createCheckout(email);
      await deliverPaidCheckout(fixture);

      assert.equal(mailsFor(email).length, 1);

      const firstToken = activationTokenFor(email);
      const known = await postJson("/api/v1/auth/resend-activation", {
        email,
      });

      assert.equal(known.status, 200);
      assert.equal(mailsFor(email).length, 2);

      const secondToken = activationTokenFor(email);
      assert.notEqual(secondToken, firstToken);

      const unknown = await postJson("/api/v1/auth/resend-activation", {
        email: unknownEmail,
      });

      assert.equal(unknown.status, 200);
      assert.deepEqual(unknown.body, known.body);
      assert.equal(mailsFor(unknownEmail).length, 0);

      // An activated account is left alone, with the same reply.
      const activatedFixture = await createCheckout(activatedEmail);
      await deliverPaidCheckout(activatedFixture);

      const activated = await postJson("/api/v1/auth/activate", {
        token: activationTokenFor(activatedEmail),
        password: ACTIVATION_PASSWORD,
      });

      assert.equal(activated.status, 200);

      const before = mailsFor(activatedEmail).length;
      const afterActivation = await postJson(
        "/api/v1/auth/resend-activation",
        { email: activatedEmail },
      );

      assert.equal(afterActivation.status, 200);
      assert.deepEqual(afterActivation.body, known.body);
      assert.equal(mailsFor(activatedEmail).length, before);
    } finally {
      await cleanup(email);
      await cleanup(activatedEmail);
    }
  }),

  test("the plain activation token is never stored in the database or audit metadata", async () => {
    const email = newEmail();

    try {
      const fixture = await createCheckout(email);
      await deliverPaidCheckout(fixture);

      const token = activationTokenFor(email);
      const pending = await findCustomer(email);

      assert.ok(pending);
      assert.equal(pending.activationTokenHash, sha256Hex(token));
      assert.equal(pending.activationTokenHash?.length, 64);
      assert.equal(JSON.stringify(pending).includes(token), false);

      const activated = await postJson("/api/v1/auth/activate", {
        token,
        password: ACTIVATION_PASSWORD,
      });

      assert.equal(activated.status, 200);

      const customer = await findCustomer(email);

      assert.ok(customer);
      assert.equal(JSON.stringify(customer).includes(token), false);

      const auditRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, "customer"),
            eq(auditLogs.entityId, customer.id),
          ),
        );

      assert.equal(auditRows.length, 1);

      const audit = auditRows[0];

      assert.ok(audit);
      assert.equal(audit.actorType, "customer");
      assert.equal(audit.actorId, customer.id);
      assert.equal(audit.action, "customer.activated");
      assert.deepEqual(audit.metadata, {});
      assert.equal(JSON.stringify(audit.metadata).includes(token), false);
    } finally {
      await cleanup(email);
    }
  }),
];

export const suiteTests: Array<Promise<void>> = [
  ...tests,
  // Runs after every test above has settled. Only this suite's TEST- fixtures are
  // removed; the shared webhook cleanup handles checkouts and events.
  Promise.allSettled(tests).then(async () => {
    await cleanStaleFixtures();
    setMailSender(null);
  }),
];
