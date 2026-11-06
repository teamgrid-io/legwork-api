import type { Request, Response } from "express";
import { createRequestSchema } from "./schema.js";
import { createRequest } from "./service.js";

export async function createRequestController(
  req: Request,
  res: Response,
): Promise<void> {
  const input = createRequestSchema.parse(req.body);
  const result = await createRequest(input);
  res.status(201).json(result);
}
