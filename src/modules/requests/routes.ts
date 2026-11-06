import { Router } from "express";
import { createRequestController } from "./controller.js";

export const requestsRouter = Router();

requestsRouter.post("/requests", createRequestController);
