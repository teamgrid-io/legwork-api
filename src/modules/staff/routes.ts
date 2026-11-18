import { Router } from "express";
import {
  approvePaymentController,
  listPaymentsController,
  loginController,
} from "./controller.js";
import { requireRole, requireStaff } from "./middleware.js";
import { loginRateLimiter } from "./rate-limit.js";

export const staffRouter = Router();

staffRouter.post("/login", loginRateLimiter, loginController);
staffRouter.get(
  "/payments",
  requireStaff,
  requireRole("admin", "agent"),
  listPaymentsController,
);
staffRouter.post(
  "/payments/:id/approve",
  requireStaff,
  requireRole("admin"),
  approvePaymentController,
);
