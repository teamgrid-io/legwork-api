import { Router } from "express";
import { requireCustomer } from "../customer/middleware.js";
import {
  getApplicantFormController,
  saveAnswersController,
  submitApplicationController,
} from "./controller.js";

export const applicationsRouter = Router();

applicationsRouter.get(
  "/applicants/:applicantId/form",
  requireCustomer,
  getApplicantFormController,
);

applicationsRouter.put(
  "/applicants/:applicantId/answers",
  requireCustomer,
  saveAnswersController,
);

applicationsRouter.post(
  "/applicants/:applicantId/submit",
  requireCustomer,
  submitApplicationController,
);
