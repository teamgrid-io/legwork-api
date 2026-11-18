import { z } from "zod";

export const loginSchema = z.object({
  // Normalised in the controller; length capped so a login cannot feed an
  // unbounded string to scrypt.
  email: z.email().max(320),
  password: z.string().min(1).max(1024),
});

export type LoginInput = z.infer<typeof loginSchema>;
