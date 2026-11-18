import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { staffUsers } from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";
import { dummyVerify, verifyPassword } from "./password.js";
import { loginSchema } from "./schema.js";
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
