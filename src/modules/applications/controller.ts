import type { Request, Response } from "express";
import { HttpError } from "../../lib/errors.js";
import {
  applicantIdParamSchema,
  saveAnswersBodySchema,
} from "./schema.js";
import { saveAnswers } from "./service.js";
import { verifyAccessToken } from "./tokens.js";

export async function saveAnswersController(
  req: Request,
  res: Response,
): Promise<void> {
  const { applicantId } = applicantIdParamSchema.parse(req.params);
  const token = req.headers["x-applicant-token"];

  if (typeof token !== "string" || !verifyAccessToken(applicantId, token)) {
    throw new HttpError(401, "Invalid access token");
  }

  const body = saveAnswersBodySchema.parse(req.body);
  const result = await saveAnswers(applicantId, body.answers);

  res.json(result);
}
