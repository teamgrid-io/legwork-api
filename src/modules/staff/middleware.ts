import type { NextFunction, Request, RequestHandler, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { staffUsers } from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";
import { verifyStaffToken } from "./token.js";

export type StaffRole = "admin" | "agent";

export interface StaffIdentity {
  readonly id: string;
  readonly role: StaffRole;
}

type StaffLocals = { staff?: StaffIdentity };

function unauthorized(): never {
  throw new HttpError(401, "Authentication required");
}

/**
 * Bearer token -> verified subject -> live staff row. The database is the
 * authority for role and active status, so a deleted, deactivated, or demoted
 * account loses access immediately.
 */
export async function requireStaff(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;

  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    unauthorized();
  }

  const token = header.slice("Bearer ".length).trim();

  if (!token) {
    unauthorized();
  }

  let staffId: string;

  try {
    staffId = await verifyStaffToken(token);
  } catch {
    unauthorized();
  }

  const [staff] = await db
    .select({
      id: staffUsers.id,
      role: staffUsers.role,
      active: staffUsers.active,
    })
    .from(staffUsers)
    .where(eq(staffUsers.id, staffId))
    .limit(1);

  if (!staff || !staff.active) {
    unauthorized();
  }

  (res.locals as StaffLocals).staff = {
    id: staff.id,
    role: staff.role as StaffRole,
  };

  next();
}

/**
 * Role gate. Must run after requireStaff; 401 when nothing was attached, 403
 * when the attached role is not allowed.
 */
export function requireRole(...roles: readonly StaffRole[]): RequestHandler {
  return (_req, res, next) => {
    const staff = (res.locals as StaffLocals).staff;

    if (!staff) {
      unauthorized();
    }

    if (!roles.includes(staff.role)) {
      throw new HttpError(403, "Forbidden");
    }

    next();
  };
}

export function staffFromLocals(res: Response): StaffIdentity {
  const staff = (res.locals as StaffLocals).staff;

  if (!staff) {
    unauthorized();
  }

  return staff;
}
