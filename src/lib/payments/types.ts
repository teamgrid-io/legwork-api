export interface CheckoutInput {
  reference: string;
  amountCents: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  url: string;
  sessionId: string;
}

export interface PaymentProvider {
  name: "stripe" | "dummy";
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
  isPaid(sessionId: string): Promise<boolean>;
}
