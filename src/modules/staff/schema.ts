import { z } from "zod";

export const loginSchema = z.object({
  // Normalised in the controller; length capped so a login cannot feed an
  // unbounded string to scrypt.
  email: z.email().max(320),
  password: z.string().min(1).max(1024),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const paymentIdParamSchema = z.object({ id: z.uuid() });

/**
 * `Idempotency-Key` is a header, so it is read separately from the body and
 * validated on its own: absent, blank, too short, or too long is a 400.
 */
export const idempotencyKeySchema = z.string().trim().min(8).max(255);

export const approveBodySchema = z
  .object({
    // The approver's free text only. Reason codes are server-derived; unknown
    // fields (an amount, a status, a reason) are rejected.
    note: z.string().max(500).optional(),
  })
  .strict();

export type ApproveInput = z.infer<typeof approveBodySchema>;

const paymentStatusSchema = z.enum([
  "succeeded",
  "review_required",
  "order_created",
]);

export const listPaymentsQuerySchema = z.object({
  status: paymentStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;
