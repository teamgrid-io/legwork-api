import { Router } from "express";
import { checkoutController, verifyController } from "./controller.js";

export const paymentsRouter = Router();

paymentsRouter.post("/requests/:id/checkout", checkoutController);
paymentsRouter.get("/payments/verify", verifyController);
