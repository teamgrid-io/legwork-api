import type { Request, Response } from "express";
import { HttpError } from "../../lib/errors.js";
import { answersSchema } from "./schema.js";
import { getVisibleFields } from "./service.js";

function parseAnswers(raw: unknown): Record<string, unknown> {
  if (raw === undefined) {
    return {};
  }

  if (typeof raw !== "string") {
    throw new HttpError(400, "answers must be valid JSON");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "answers must be valid JSON");
  }

  return answersSchema.parse(parsed);
}

export async function getFormController(
  req: Request,
  res: Response,
): Promise<void> {
  const visaProductId = req.params.visaProductId;

  if (typeof visaProductId !== "string" || visaProductId.length === 0) {
    throw new HttpError(400, "visaProductId is required");
  }

  const answers = parseAnswers(req.query.answers);
  const result = await getVisibleFields({ visaProductId, answers });

  res.json(result);
}
