import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { auditLogs, customers } from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";
import { sendMail } from "../../lib/mail.js";
import { hashPassword } from "../staff/password.js";
import { CUSTOMER_TOKEN_TTL_SECONDS, signCustomerToken } from "./token.js";

const ACTIVATION_TOKEN_BYTES = 32;
const ACTIVATION_TTL_MS = 48 * 60 * 60 * 1000;

export interface ActivatedCustomer {
  readonly token: string;
  readonly expiresInSeconds: number;
  readonly customer: {
    readonly id: string;
    readonly name: string;
    readonly email: string;
  };
}

/** Emails are stored and looked up in one canonical form. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Only the hash is stored. A leaked database row therefore cannot be turned
 * back into a working activation link.
 */
function hashActivationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Issue a fresh activation link for one customer. Any previous link is replaced
 * by overwriting the hash, so at most one link is ever valid.
 */
export async function issueActivation(customerId: string): Promise<void> {
  const token = randomBytes(ACTIVATION_TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + ACTIVATION_TTL_MS);

  const [customer] = await db
    .update(customers)
    .set({
      activationTokenHash: hashActivationToken(token),
      activationExpiresAt: expiresAt,
    })
    .where(eq(customers.id, customerId))
    .returning({ email: customers.email, name: customers.name });

  if (!customer) {
    throw new HttpError(404, "Customer not found");
  }

  await sendMail({
    to: customer.email,
    subject: "Activate your Legwork account",
    text: [
      `Hello ${customer.name},`,
      "",
      "Activate your account by opening this link:",
      `${config.webUrl}/activate?token=${token}`,
      "",
      "The link expires in 48 hours. If you did not request this email, ignore it.",
    ].join("\n"),
  });
}

/**
 * Consume an activation link and set the first password. The single guarded
 * UPDATE is the whole decision: a reused, expired, or unknown token matches no
 * row. The audit row is written in the same transaction, so an activation can
 * never be recorded without happening, or the reverse.
 */
export async function activateAccount(
  activationToken: string,
  password: string,
): Promise<ActivatedCustomer> {
  const tokenHash = hashActivationToken(activationToken);

  // scrypt runs outside the transaction: no CPU-bound work holds row locks.
  const passwordHash = await hashPassword(password);

  const customer = await db.transaction(async (tx) => {
    const [activated] = await tx
      .update(customers)
      .set({
        passwordHash,
        activatedAt: sql`now()`,
        activationTokenHash: null,
        activationExpiresAt: null,
      })
      .where(
        and(
          eq(customers.activationTokenHash, tokenHash),
          gt(customers.activationExpiresAt, sql`now()`),
          isNull(customers.activatedAt),
        ),
      )
      .returning({
        id: customers.id,
        name: customers.name,
        email: customers.email,
      });

    if (!activated) {
      throw new HttpError(400, "Invalid or expired activation link");
    }

    await tx.insert(auditLogs).values({
      actorType: "customer",
      actorId: activated.id,
      action: "customer.activated",
      entityType: "customer",
      entityId: activated.id,
      metadata: {},
    });

    return activated;
  });

  const token = await signCustomerToken(customer.id);

  return {
    token,
    expiresInSeconds: CUSTOMER_TOKEN_TTL_SECONDS,
    customer: {
      id: customer.id,
      name: customer.name,
      email: customer.email,
    },
  };
}

/**
 * Resend an activation link only when an unactivated account exists. The caller
 * answers the same way either way, so this must not reveal which case applied.
 */
export async function resendActivation(email: string): Promise<void> {
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.email, normalizeEmail(email)),
        isNull(customers.activatedAt),
      ),
    )
    .limit(1);

  if (!customer) {
    return;
  }

  try {
    await issueActivation(customer.id);
  } catch (error) {
    // Fixed fields only: the address is never logged.
    console.error(
      `Could not issue customer activation for ${customer.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
