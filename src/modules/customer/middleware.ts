import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";
import { verifyCustomerToken } from "./token.js";

export interface CustomerIdentity {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string | null;
}

type CustomerLocals = { customer?: CustomerIdentity };

function unauthorized(): never {
  throw new HttpError(401, "Authentication required");
}

/**
 * Bearer token -> verified subject -> live customer row. The database is the
 * authority for activation, so a token minted before an account was deleted or
 * somehow deactivated stops working immediately.
 */
export async function requireCustomer(
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

  let customerId: string;

  try {
    customerId = await verifyCustomerToken(token);
  } catch {
    unauthorized();
  }

  const [customer] = await db
    .select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      phone: customers.phone,
      activatedAt: customers.activatedAt,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);

  if (!customer || customer.activatedAt === null) {
    unauthorized();
  }

  (res.locals as CustomerLocals).customer = {
    id: customer.id,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
  };

  next();
}

export function customerFromLocals(res: Response): CustomerIdentity {
  const customer = (res.locals as CustomerLocals).customer;

  if (!customer) {
    unauthorized();
  }

  return customer;
}
