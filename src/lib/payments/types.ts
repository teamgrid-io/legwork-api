export interface CheckoutInput {
  reference: string;
  amountCents: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey?: string;
}

export interface CheckoutSession {
  url: string;
  sessionId: string;
  /** Unix seconds, copied from Stripe's session.expires_at. */
  expiresAt: number;
}

export type CheckoutStatus = "open" | "complete" | "expired";

export interface ExistingCheckout {
  status: CheckoutStatus;
  url: string | null;
  /** Unix seconds, copied from Stripe's session.expires_at. */
  expiresAt: number;
}

export interface PaymentProvider {
  name: "stripe" | "dummy";
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
  getCheckout(sessionId: string): Promise<ExistingCheckout | null>;
  isPaid(sessionId: string): Promise<boolean>;
}
