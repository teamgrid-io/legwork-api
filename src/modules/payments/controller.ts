import type { Request, Response } from "express";
import { HttpError } from "../../lib/errors.js";
import { requestIdParamSchema } from "./schema.js";
import { createCheckoutForRequest, verifyPayment } from "./service.js";

export async function checkoutController(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = requestIdParamSchema.parse(req.params);

  const result = await createCheckoutForRequest(id);
  res.status(200).json(result);
}

export async function verifyController(
  req: Request,
  res: Response,
): Promise<void> {
  const sessionId = req.query.session_id;

  if (typeof sessionId !== "string") {
    throw new HttpError(400, "session_id is required");
  }

  const result = await verifyPayment(sessionId);
  res.json(result);
}
