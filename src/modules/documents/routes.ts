import { Router } from "express";
import multer from "multer";
import { uploadDocumentController } from "./controller.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5242880, files: 1 },
});

export const documentsRouter = Router();

documentsRouter.post(
  "/applicants/:applicantId/documents",
  upload.single("file"),
  uploadDocumentController,
);
