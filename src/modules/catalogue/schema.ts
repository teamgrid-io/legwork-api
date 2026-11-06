import { z } from "zod";

export const visaCheckQuerySchema = z.object({
  passport: z
    .string({ error: "passport is required" })
    .regex(/^[A-Za-z]{2}$/, "passport must be a 2-letter country code")
    .transform((value) => value.toUpperCase()),
  destination: z
    .string({ error: "destination is required" })
    .regex(/^[A-Za-z]{2}$/, "destination must be a 2-letter country code")
    .transform((value) => value.toUpperCase()),
});
