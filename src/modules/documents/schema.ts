import { z } from "zod";

export const applicantIdParamSchema = z.object({
  applicantId: z.uuid(),
});

export const uploadDocumentBodySchema = z.object({
  documentType: z.string(),
});
