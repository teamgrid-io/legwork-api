import { Router } from "express";
import {
  activateController,
  customerLoginController,
  getOrderController,
  listOrdersController,
  meController,
  resendActivationController,
} from "./controller.js";
import { requireCustomer } from "./middleware.js";
import {
  activationRateLimiter,
  loginRateLimiter,
  resendActivationRateLimiter,
} from "./rate-limit.js";

export const customerAuthRouter = Router();

customerAuthRouter.post(
  "/activate",
  activationRateLimiter,
  activateController,
);
customerAuthRouter.post("/login", loginRateLimiter, customerLoginController);
customerAuthRouter.get("/me", requireCustomer, meController);
customerAuthRouter.get("/orders", requireCustomer, listOrdersController);
customerAuthRouter.get(
  "/orders/:orderNumber",
  requireCustomer,
  getOrderController,
);
customerAuthRouter.post(
  "/resend-activation",
  resendActivationRateLimiter,
  resendActivationController,
);
