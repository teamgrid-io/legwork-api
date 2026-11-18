import { Router } from "express";
import { loginController } from "./controller.js";

export const staffRouter = Router();

staffRouter.post("/login", loginController);
