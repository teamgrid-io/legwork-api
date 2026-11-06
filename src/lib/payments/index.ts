import { config } from "../../config.js";
import { DummyPaymentProvider } from "./dummy.js";
import type { PaymentProvider } from "./types.js";

function createPaymentProvider(): PaymentProvider {
  if (config.paymentProvider === "stripe") {
    throw new Error("Stripe provider not implemented yet");
  }

  return new DummyPaymentProvider();
}

export const paymentProvider: PaymentProvider = createPaymentProvider();
