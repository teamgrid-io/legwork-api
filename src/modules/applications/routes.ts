import { Router } from "express";
import { saveAnswersController } from "./controller.js";

export const applicationsRouter = Router();

applicationsRouter.put(
  "/applicants/:applicantId/answers",
  saveAnswersController,
);
