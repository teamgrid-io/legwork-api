import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";
import { dummyVerify, verifyPassword } from "../staff/password.js";
import {
  activateAccount,
  normalizeEmail,
  resendActivation,
} from "./activation.js";
import { customerFromLocals } from "./middleware.js";
import { getCustomerOrder, listCustomerOrders } from "./orders.js";
import {
  activateSchema,
  listOrdersQuerySchema,
  loginSchema,
  orderNumberParamSchema,
  resendActivationSchema,
} from "./schema.js";
import { CUSTOMER_TOKEN_TTL_SECONDS, signCustomerToken } from "./token.js";

/**
 * POST /api/v1/auth/activate
 *
 * The link token and the first password. The service decides everything with
 * one guarded UPDATE; this handler only parses and shapes the response.
 */
export async function activateController(
  req: Request,
  res: Response,
): Promise<void> {
  const { token, password } = activateSchema.parse(req.body);

  const result = await activateAccount(token, password);

  res.status(200).json(result);
}

/**
 * POST /api/v1/auth/login
 *
 * Unknown email, unactivated account, and wrong password are indistinguishable:
 * same status, same message, and a dummy scrypt run whenever there is no usable
 * hash, so neither the body nor the timing reveals which case applied.
 */
export async function customerLoginController(
  req: Request,
  res: Response,
): Promise<void> {
  const { email, password } = loginSchema.parse(req.body);

  const [customer] = await db
    .select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      passwordHash: customers.passwordHash,
      activatedAt: customers.activatedAt,
    })
    .from(customers)
    .where(eq(customers.email, normalizeEmail(email)))
    .limit(1);

  if (
    !customer ||
    customer.activatedAt === null ||
    customer.passwordHash === null
  ) {
    await dummyVerify(password);
    throw new HttpError(401, "Invalid credentials");
  }

  const passwordMatches = await verifyPassword(password, customer.passwordHash);

  if (!passwordMatches) {
    throw new HttpError(401, "Invalid credentials");
  }

  const token = await signCustomerToken(customer.id);

  res.status(200).json({
    token,
    expiresInSeconds: CUSTOMER_TOKEN_TTL_SECONDS,
    customer: {
      id: customer.id,
      name: customer.name,
      email: customer.email,
    },
  });
}

/**
 * GET /api/v1/auth/me
 *
 * Auth is enforced by requireCustomer, which also rejects a token whose row is
 * gone or not activated.
 */
export async function meController(
  _req: Request,
  res: Response,
): Promise<void> {
  const customer = customerFromLocals(res);

  res.status(200).json({
    id: customer.id,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
  });
}

/**
 * GET /api/v1/auth/orders
 *
 * The signed-in customer's own orders, newest first, paginated.
 */
export async function listOrdersController(
  req: Request,
  res: Response,
): Promise<void> {
  const { limit, offset } = listOrdersQuerySchema.parse(req.query);
  const customer = customerFromLocals(res);
  const orders = await listCustomerOrders(customer.id, { limit, offset });

  res.status(200).json({ orders });
}

/**
 * GET /api/v1/auth/orders/:orderNumber
 *
 * Ownership is part of the query, so another customer's order is a 404.
 */
export async function getOrderController(
  req: Request,
  res: Response,
): Promise<void> {
  const { orderNumber } = orderNumberParamSchema.parse(req.params);
  const customer = customerFromLocals(res);
  const order = await getCustomerOrder(customer.id, orderNumber);

  res.status(200).json(order);
}

/**
 * POST /api/v1/auth/resend-activation
 *
 * Deliberately identical for a known and an unknown address. Only the mail
 * side effect differs, and it happens only for an unactivated account.
 */
export async function resendActivationController(
  req: Request,
  res: Response,
): Promise<void> {
  const { email } = resendActivationSchema.parse(req.body);

  await resendActivation(email);

  res.status(200).json({
    message: "If the account exists and is not activated, an email was sent",
  });
}
