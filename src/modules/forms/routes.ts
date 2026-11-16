import { Router } from "express";
import { getFormController } from "./controller.js";

export const formsRouter = Router();

formsRouter.get("/visaProducts/:visaProductId/form", getFormController);
