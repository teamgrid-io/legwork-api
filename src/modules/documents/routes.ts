import { Router } from "express";
import multer from "multer";
import { requireCustomer } from "../customer/middleware.js";
import { uploadDocumentController } from "./controller.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5242880, files: 1 },
});

export const documentsRouter = Router();

documentsRouter.post(
  "/applicants/:applicantId/documents",
  requireCustomer,
  upload.single("file"),
  uploadDocumentController,
);
