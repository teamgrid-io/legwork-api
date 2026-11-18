import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { staffUsers } from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";
import { approvePayment, listPayments } from "./approval.js";
import { staffFromLocals } from "./middleware.js";
import { dummyVerify, verifyPassword } from "./password.js";
import {
  approveBodySchema,
  idempotencyKeySchema,
  listPaymentsQuerySchema,
  loginSchema,
  paymentIdParamSchema,
} from "./schema.js";
import { signStaffToken, TOKEN_TTL_SECONDS } from "./token.js";

/**
 * POST /api/staff/login
 *
 * Unknown email, wrong password, and inactive account are indistinguishable:
 * same status, same message, and comparable work (a dummy scrypt run when there
 * is no usable hash), so neither the response nor its timing reveals which
 * case applied.
 */
export async function loginController(
  req: Request,
  res: Response,
): Promise<void> {
  const { email, password } = loginSchema.parse(req.body);
  const normalizedEmail = email.trim().toLowerCase();

  const [staff] = await db
    .select({
      id: staffUsers.id,
      name: staffUsers.name,
      role: staffUsers.role,
      active: staffUsers.active,
      passwordHash: staffUsers.passwordHash,
    })
    .from(staffUsers)
    .where(eq(staffUsers.email, normalizedEmail))
    .limit(1);

  if (!staff || !staff.active) {
    await dummyVerify(password);
    throw new HttpError(401, "Invalid credentials");
  }

  const passwordMatches = await verifyPassword(password, staff.passwordHash);

  if (!passwordMatches) {
    throw new HttpError(401, "Invalid credentials");
  }

  const token = await signStaffToken(staff.id);

  res.status(200).json({
    token,
    expiresInSeconds: TOKEN_TTL_SECONDS,
    staff: {
      id: staff.id,
      name: staff.name,
      role: staff.role,
    },
  });
}

/**
 * POST /api/staff/payments/:id/approve
 *
 * Auth and role are enforced by the route (requireStaff + admin). This handler
 * validates the path id, the required Idempotency-Key header, and the optional
 * note, then delegates the single approval transaction to approval.ts.
 */
export async function approvePaymentController(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = staffFromLocals(res);
  const { id } = paymentIdParamSchema.parse(req.params);
  const idempotencyKey = idempotencyKeySchema.parse(
    req.header("Idempotency-Key"),
  );
  const { note } = approveBodySchema.parse(req.body ?? {});

  const result = await approvePayment(id, staff.id, idempotencyKey, note);

  res.status(200).json(result);
}

/**
 * GET /api/staff/payments
 *
 * Admin and agent may read. The query filter, page size, and offset are parsed
 * here; the list itself is ordered created_at DESC, id DESC.
 */
export async function listPaymentsController(
  req: Request,
  res: Response,
): Promise<void> {
  const query = listPaymentsQuerySchema.parse(req.query);
  const result = await listPayments(query);

  res.status(200).json(result);
}
