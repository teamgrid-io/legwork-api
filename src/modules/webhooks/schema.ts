import { z } from "zod";

export const dummyPaymentBodySchema = z.object({
  sessionId: z.string().min(1),
});
