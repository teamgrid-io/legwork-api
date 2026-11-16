import type { Request, Response } from "express";
import { HttpError } from "../../lib/errors.js";
import { verifyAccessToken } from "../applications/tokens.js";
import {
  applicantIdParamSchema,
  uploadDocumentBodySchema,
} from "./schema.js";
import { uploadDocument } from "./service.js";

export async function uploadDocumentController(
  req: Request,
  res: Response,
): Promise<void> {
  const { applicantId } = applicantIdParamSchema.parse(req.params);
  const token = req.headers["x-applicant-token"];

  if (typeof token !== "string" || !verifyAccessToken(applicantId, token)) {
    throw new HttpError(401, "Invalid access token");
  }

  const body = uploadDocumentBodySchema.parse(req.body);

  if (!req.file) {
    throw new HttpError(400, "File is required");
  }

  const result = await uploadDocument({
    applicantId,
    documentType: body.documentType,
    buffer: req.file.buffer,
    declaredMime: req.file.mimetype,
  });

  res.status(201).json(result);
}
