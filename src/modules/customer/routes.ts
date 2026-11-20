import { Router } from "express";
import {
  activateController,
  customerLoginController,
  meController,
  resendActivationController,
} from "./controller.js";
import { requireCustomer } from "./middleware.js";

export const customerAuthRouter = Router();

// TODO: shared rate limit
// The staff limiter (modules/staff/rate-limit.ts) is a concrete middleware, not
// a factory, and its store is keyed for the staff login route. These endpoints
// are therefore unthrottled until a shared limiter exists.
customerAuthRouter.post("/activate", activateController);
customerAuthRouter.post("/login", customerLoginController);
customerAuthRouter.get("/me", requireCustomer, meController);
customerAuthRouter.post("/resend-activation", resendActivationController);
