import type { Request, Response } from "express";
import { HttpError } from "../../lib/errors.js";
import { customerFromLocals } from "../customer/middleware.js";
import { assertApplicantOwnedByCustomer } from "../customer/ownership.js";
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
  const customer = customerFromLocals(res);

  await assertApplicantOwnedByCustomer({
    applicantId,
    customerId: customer.id,
  });

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
