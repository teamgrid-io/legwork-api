import { z } from "zod";

// Strict objects: an extra key is a 400 rather than silently ignored.
export const activateSchema = z
  .object({
    token: z.string().min(1).max(512),
    password: z.string().min(10).max(128),
  })
  .strict();

export type ActivateInput = z.infer<typeof activateSchema>;

export const loginSchema = z
  .object({
    // Normalised in the controller. The cap keeps an unbounded string away from
    // scrypt; a short password is simply a wrong password (401), not a 400.
    email: z.email().max(320),
    password: z.string().min(1).max(128),
  })
  .strict();

export type CustomerLoginInput = z.infer<typeof loginSchema>;

export const resendActivationSchema = z
  .object({
    email: z.email().max(320),
  })
  .strict();

export type ResendActivationInput = z.infer<typeof resendActivationSchema>;

export const listOrdersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

export const orderNumberParamSchema = z.object({
  orderNumber: z.string().min(1).max(64),
});
