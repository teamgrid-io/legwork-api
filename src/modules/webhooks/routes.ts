import express, { Router } from "express";
import {
  dummyPaymentController,
  stripeWebhookController,
} from "./controller.js";

export const webhooksRouter = Router();

webhooksRouter.post(
  "/webhooks/dummy-payment",
  express.json(),
  dummyPaymentController,
);

webhooksRouter.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json" }),
  stripeWebhookController,
);
