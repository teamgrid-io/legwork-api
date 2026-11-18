import { randomUUID } from "node:crypto";
import { config } from "../../config.js";
import type {
  CheckoutInput,
  CheckoutSession,
  ExistingCheckout,
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
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 60;

    return { url, sessionId, expiresAt };
  }

  async getCheckout(_sessionId: string): Promise<ExistingCheckout | null> {
    return null;
  }

  async isPaid(sessionId: string): Promise<boolean> {
    return sessionId.startsWith("dummy_");
  }
}
