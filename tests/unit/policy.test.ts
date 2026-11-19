import assert from "node:assert/strict";
import test from "node:test";
import {
  decidePaymentOutcome,
  type DecisionInput,
} from "../../src/modules/webhooks/policy.js";

const expiresAt = new Date("2026-01-01T00:00:00.000Z");
const graceSeconds = 300;
const graceMs = graceSeconds * 1000;

function atOffset(ms: number): Date {
  return new Date(expiresAt.getTime() + ms);
}

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    now: expiresAt,
    expiresAt,
    graceSeconds,
    paymentAmountCents: 10_000,
    paymentCurrency: "USD",
    checkoutAmountCents: 10_000,
    checkoutCurrency: "USD",
    ...overrides,
  };
}

test("now = expiresAt + grace exactly is late", () => {
  assert.deepEqual(decidePaymentOutcome(input({ now: atOffset(graceMs) })), [
    "late_payment",
  ]);
});

test("now = expiresAt + grace - 1 ms is not late", () => {
  assert.deepEqual(
    decidePaymentOutcome(input({ now: atOffset(graceMs - 1) })),
    [],
  );
});

test("grace 0 at now = expiresAt is late", () => {
  assert.deepEqual(
    decidePaymentOutcome(input({ now: expiresAt, graceSeconds: 0 })),
    ["late_payment"],
  );
});

test("amount mismatch only", () => {
  assert.deepEqual(
    decidePaymentOutcome(input({ paymentAmountCents: 9_999 })),
    ["amount_mismatch"],
  );
});

test("currency mismatch only", () => {
  assert.deepEqual(
    decidePaymentOutcome(input({ paymentCurrency: "EUR" })),
    ["currency_mismatch"],
  );
});

test("null amount includes amount_mismatch", () => {
  assert.deepEqual(
    decidePaymentOutcome(input({ paymentAmountCents: null })),
    ["amount_mismatch"],
  );
});

test("null currency includes currency_mismatch", () => {
  assert.deepEqual(
    decidePaymentOutcome(input({ paymentCurrency: null })),
    ["currency_mismatch"],
  );
});

test("late + amount mismatch", () => {
  assert.deepEqual(
    decidePaymentOutcome(
      input({ now: atOffset(graceMs), paymentAmountCents: 5_000 }),
    ),
    ["late_payment", "amount_mismatch"],
  );
});

test("late + amount + currency mismatch", () => {
  assert.deepEqual(
    decidePaymentOutcome(
      input({
        now: atOffset(graceMs),
        paymentAmountCents: 5_000,
        paymentCurrency: "EUR",
      }),
    ),
    ["late_payment", "amount_mismatch", "currency_mismatch"],
  );
});

test("late + amount mismatch, 1 ms before the deadline, is only a mismatch", () => {
  assert.deepEqual(
    decidePaymentOutcome(
      input({
        now: atOffset(graceMs - 1),
        paymentAmountCents: 5_000,
      }),
    ),
    ["amount_mismatch"],
  );
});
