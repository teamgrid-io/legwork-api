import { Router } from "express";
import {
  saveAnswersController,
  submitApplicationController,
} from "./controller.js";

export const applicationsRouter = Router();

applicationsRouter.put(
  "/applicants/:applicantId/answers",
  saveAnswersController,
);

applicationsRouter.post(
  "/applicants/:applicantId/submit",
  submitApplicationController,
);
