import { config } from "../../config.js";
import { DummyPaymentProvider } from "./dummy.js";
import { StripePaymentProvider } from "./stripe.js";
import type { PaymentProvider } from "./types.js";

function createPaymentProvider(): PaymentProvider {
  if (config.paymentProvider === "stripe") {
    return new StripePaymentProvider();
  }

  return new DummyPaymentProvider();
}

export const paymentProvider: PaymentProvider = createPaymentProvider();
