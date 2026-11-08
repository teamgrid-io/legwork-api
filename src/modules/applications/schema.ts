import { z } from "zod";

export const applicantIdParamSchema = z.object({
  applicantId: z.uuid(),
});

const answerValueSchema = z.union([
  z.string(),
  z.array(z.string()),
  z.boolean(),
  z.number(),
  z.null(),
]);

export const saveAnswersBodySchema = z
  .object({
    answers: z.record(z.string(), answerValueSchema),
  })
  .strict();
