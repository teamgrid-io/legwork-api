/**
 * Pure late-payment decision policy.
 *
 * No database, no config import, no Date.now(): the caller supplies `now`, the
 * checkout deadline, and the grace window, so every rule is directly testable.
 */

export type ReviewReason =
  | "late_payment"
  | "amount_mismatch"
  | "currency_mismatch";

/**
 * Hard cap on delivery claims per Stripe event id. attempt_count is the number
 * of claims: 1 on first insert, +1 on each successful reclaim. An event that
 * reaches the cap is never reclaimed again and needs a human.
 */
export const MAX_STRIPE_EVENT_ATTEMPTS = 5;

export interface DecisionInput {
  now: Date;
  expiresAt: Date;
  graceSeconds: number;
  paymentAmountCents: number | null;
  paymentCurrency: string | null;
  checkoutAmountCents: number;
  checkoutCurrency: string;
}

/**
 * Returns every applicable reason code in fixed order:
 * ["late_payment", "amount_mismatch", "currency_mismatch"].
 * An empty array means the payment is within the deadline and matches.
 *
 * The deadline boundary is inclusive for lateness:
 *   now >= expiresAt + graceSeconds  ->  late_payment
 * so now = expiresAt + grace - 1 ms is not late.
 */
export function decidePaymentOutcome(input: DecisionInput): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  const deadlineMs = input.expiresAt.getTime() + input.graceSeconds * 1000;

  if (input.now.getTime() >= deadlineMs) {
    reasons.push("late_payment");
  }

  if (
    input.paymentAmountCents === null ||
    input.paymentAmountCents !== input.checkoutAmountCents
  ) {
    reasons.push("amount_mismatch");
  }

  if (
    input.paymentCurrency === null ||
    input.paymentCurrency.toUpperCase() !== input.checkoutCurrency.toUpperCase()
  ) {
    reasons.push("currency_mismatch");
  }

  return reasons;
}
