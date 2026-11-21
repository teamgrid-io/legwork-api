import type { Request, Response } from "express";
import { customerFromLocals } from "../customer/middleware.js";
import { assertApplicantOwnedByCustomer } from "../customer/ownership.js";
import {
  applicantIdParamSchema,
  saveAnswersBodySchema,
} from "./schema.js";
import { saveAnswers, submitApplication } from "./service.js";

export async function saveAnswersController(
  req: Request,
  res: Response,
): Promise<void> {
  const { applicantId } = applicantIdParamSchema.parse(req.params);
  const customer = customerFromLocals(res);

  await assertApplicantOwnedByCustomer({
    applicantId,
    customerId: customer.id,
  });

  const body = saveAnswersBodySchema.parse(req.body);
  const result = await saveAnswers(applicantId, body.answers);

  res.json(result);
}

export async function submitApplicationController(
  req: Request,
  res: Response,
): Promise<void> {
  const { applicantId } = applicantIdParamSchema.parse(req.params);
  const customer = customerFromLocals(res);

  await assertApplicantOwnedByCustomer({
    applicantId,
    customerId: customer.id,
  });

  const result = await submitApplication(applicantId);

  res.status(200).json(result);
}
