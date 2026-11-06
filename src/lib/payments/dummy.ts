import { randomUUID } from "node:crypto";
import { config } from "../../config.js";
import type {
  CheckoutInput,
  CheckoutSession,
  PaymentProvider,
} from "./types.js";

export class DummyPaymentProvider implements PaymentProvider {
  readonly name = "dummy" as const;

  constructor() {
    if (config.isProduction) {
      throw new Error("Dummy payment provider cannot be used in production");
    }
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const sessionId = `dummy_${randomUUID()}`;
    const url = `${input.successUrl}?session_id=${sessionId}`;

    return { url, sessionId };
  }

  async isPaid(sessionId: string): Promise<boolean> {
    return sessionId.startsWith("dummy_");
  }
}
